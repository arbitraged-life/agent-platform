# Ticket: config values have a trailing `\r` on Windows-authored files

`parseConfig(text)` in `lib.js` parses `key=value` lines into an object. Files
authored on Windows use CRLF (`\r\n`) line endings; on those files every
parsed value (and, for the last line, the key too) ends with a literal `\r`
character that leaks into downstream comparisons.

Fix `parseConfig` so parsed keys and values never contain a trailing `\r`,
for both CRLF and LF input, without trimming meaningful surrounding spaces
inside the value.
