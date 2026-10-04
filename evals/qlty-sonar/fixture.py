import os
import subprocess

def run_command(value):
    return subprocess.run(value, shell=True, check=False)
