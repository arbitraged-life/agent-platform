"""Exercise the reusable workflow's token handling without network or credentials."""
import contextlib
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import yaml

ROOT = Path(__file__).resolve().parents[1]


class ReviewWorkflowTests(unittest.TestCase):
    def test_identity_acquisition_masks_token_and_rejects_bad_responses(self):
        workflow = yaml.safe_load((ROOT / '.github/workflows/review-reusable.yml').read_text())
        step = next(step for step in workflow['jobs']['review']['steps']
                    if step.get('name') == 'Acquire explicitly requested provider identity')
        code = step['run'].split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'environment'
            environment = {'GITHUB_ENV': str(output), 'PROVIDER_AUDIENCE': 'https://provider.example.invalid',
                           'ACTIONS_ID_TOKEN_REQUEST_URL': 'https://identity.example.invalid?request=1',
                           'ACTIONS_ID_TOKEN_REQUEST_TOKEN': 'synthetic'}
            with patch.dict(os.environ, environment, clear=True):
                with patch('runtime.review.transport.request', return_value={'value': 'header.payload.signature'}) as request:
                    printed = io.StringIO()
                    with contextlib.redirect_stdout(printed): exec(compile(code, '<workflow>', 'exec'), {})
                    self.assertEqual(printed.getvalue(), '::add-mask::header.payload.signature\n')
                    self.assertEqual(output.read_text(), 'REVIEW_OIDC_TOKEN=header.payload.signature\n')
                    self.assertIn('audience=https%3A%2F%2Fprovider.example.invalid', request.call_args.args[0])
                output.unlink()
                for response in (None, {'value': 'bad\nINJECT=1'}):
                    with patch('runtime.review.transport.request', return_value=response):
                        with self.assertRaisesRegex(SystemExit, '^Provider identity acquisition failed$'):
                            exec(compile(code, '<workflow>', 'exec'), {})
                    self.assertFalse(output.exists())
                with patch.dict(os.environ, {'SUPPLIED_PROVIDER_TOKEN': 'synthetic'}):
                    with patch('runtime.review.transport.request') as request:
                        with self.assertRaises(SystemExit): exec(compile(code, '<workflow>', 'exec'), {})
                        request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
