#!/usr/bin/env python3
"""Pre-clone all sub-repositories that A1111 needs at the exact commits
it expects. Run at Docker build time so the container needs no outbound
git access at startup."""
import subprocess, re, os, sys

LAUNCH_UTILS = 'modules/launch_utils.py'

if not os.path.exists(LAUNCH_UTILS):
    print(f'[error] {LAUNCH_UTILS} not found — run this from /app/stable-diffusion-webui', file=sys.stderr)
    sys.exit(1)

with open(LAUNCH_UTILS) as f:
    src = f.read()

repo_urls = dict(re.findall(r"(\w+)_repo\s*=\s*os\.environ\.get\([^,]+,\s*['\"]([^'\"]+)['\"]\)", src))
commits   = dict(re.findall(r"(\w+)_commit_hash\s*=\s*os\.environ\.get\([^,]+,\s*['\"]([^'\"]+)['\"]\)", src))

print(f'[info] found {len(repo_urls)} repos and {len(commits)} commit hashes in {LAUNCH_UTILS}')

dirs = {
    'stable_diffusion':    'stable-diffusion-stability-ai',
    'generative_models':   'generative-models',
    'taming_transformers': 'taming-transformers',
    'k_diffusion':         'k-diffusion',
    'codeformer':          'CodeFormer',
    'blip':                'BLIP',
    'clip':                'CLIP',
    'openclip':            'open_clip',
}

os.makedirs('repositories', exist_ok=True)
errors = []

for key, dirname in dirs.items():
    url    = repo_urls.get(key)
    commit = commits.get(key)
    dest   = os.path.join('repositories', dirname)

    if not url:
        print(f'[skip] no URL found for key "{key}" in launch_utils.py', flush=True)
        continue
    if os.path.exists(dest):
        print(f'[skip] already exists: {dest}', flush=True)
        continue

    print(f'[clone] {url}  ->  {dest}', flush=True)
    r = subprocess.run(['git', 'clone', url, dest])
    if r.returncode != 0:
        print(f'[error] git clone failed for {dirname}', file=sys.stderr)
        errors.append(dirname)
        continue

    if commit:
        print(f'[checkout] {dirname} @ {commit}', flush=True)
        r2 = subprocess.run(['git', '-C', dest, 'checkout', commit])
        if r2.returncode != 0:
            print(f'[error] git checkout failed for {dirname} @ {commit}', file=sys.stderr)
            errors.append(dirname)
            continue

    print(f'[ok] {dirname}', flush=True)

if errors:
    print(f'\n[FATAL] failed repos: {errors}', file=sys.stderr)
    sys.exit(1)

print('\nAll repositories pre-cloned successfully.')
