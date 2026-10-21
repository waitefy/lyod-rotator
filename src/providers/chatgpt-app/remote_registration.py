"""Register a local account bridge over a trusted, private SSH route."""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
from urllib.parse import urlsplit

# This runs on the configured SSH host. Only the bridge API key is transferred;
# the ChatGPT access token and the rotator admin token never cross this channel.
REMOTE = r'''
import json, os, sys, tempfile, time, urllib.request
from pathlib import Path
payload=json.load(sys.stdin)
settings=payload['remote']
session=payload['session']
path=Path(settings['serverSessionDir'])/payload['filename']
if path.exists():
    assert json.loads(path.read_text())['email'].casefold()==session['email'].casefold()
fd,name=tempfile.mkstemp(prefix='.chatgpt-connection-',dir=path.parent)
try:
    with os.fdopen(fd,'w') as f:
        json.dump(session,f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(name,path)
finally:
    Path(name).unlink(missing_ok=True)
if payload['phase']=='register':
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for attempt in range(15):
        try:
            req=urllib.request.Request(session['baseUrl']+'/models',headers={'Authorization':'Bearer '+session['apiKey']})
            with opener.open(req,timeout=2) as r:
                assert r.status==200 and isinstance(json.load(r).get('data'),list)
            break
        except Exception:
            if attempt==14: raise
            time.sleep(1)
    token=(Path(settings['serverConfigDir'])/'.admin-token').read_text().strip()
    body={'provider':payload['provider'],'sessionFile':settings['containerSessionDir']+'/'+payload['filename']}
    req=urllib.request.Request(settings['apiBaseUrl']+'/api/cli-login',data=json.dumps(body).encode(),
        headers={'Content-Type':'application/json','x-rotator-admin-token':token})
    with opener.open(req,timeout=30) as r:
        result=json.load(r)
        assert r.status==200 and result.get('ok') is True
        assert result['email'].casefold()==session['email'].casefold()
print(json.dumps({'ok':True,'email':session['email']}))
'''


def validate(remote, connection):
    host = remote['sshHost']
    if not re.fullmatch(r'[a-zA-Z0-9_.-]+@[a-zA-Z0-9][a-zA-Z0-9.-]*', host):
        raise ValueError('Invalid SSH host')
    for key in ('serverSessionDir', 'containerSessionDir', 'serverConfigDir'):
        if not re.fullmatch(r'/[a-zA-Z0-9_./-]+', remote[key]) or '..' in Path(remote[key]).parts:
            raise ValueError('Invalid server path')
    url = urlsplit(connection['baseUrl'])
    if url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port or url.username or url.password or url.query or url.fragment or url.path != '/v1':
        raise ValueError('Expected a private local bridge')
    api = urlsplit(remote['apiBaseUrl'])
    if api.scheme != 'http' or api.hostname != '127.0.0.1' or not api.port or api.username or api.password or api.query or api.fragment or api.path:
        raise ValueError('Expected a private rotator API')
    port = url.port + int(remote.get('portOffset', 10000))
    if not 1024 <= port <= 65535:
        raise ValueError('Invalid tunnel port')
    return host, url.port, port


def register(remote, connection, unit_dir=None, provider='chatgpt-app'):
    if provider not in ('chatgpt-app', 'claude-app'):
        raise ValueError('Unsupported bridge provider')
    host, local_port, remote_port = validate(remote, connection)
    digest = hashlib.sha256(connection['email'].casefold().encode()).hexdigest()[:24]
    filename = provider + '-' + digest + '.json'
    session = {key: connection[key] for key in ('email', 'apiKey')}
    if provider == 'claude-app':
        session.update({key: connection[key] for key in ('modelSelection', 'availableModels', 'adminApiKey') if key in connection})
    session['baseUrl'] = f'http://127.0.0.1:{remote_port}/v1'
    ssh = ['ssh', '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host]
    payload = dict(remote=remote, session=session, filename=filename, provider=provider)

    def call_remote(phase):
        result = subprocess.run(ssh + ['python3 -c ' + shlex.quote(REMOTE)],
                                input=json.dumps(dict(payload, phase=phase)), text=True,
                                capture_output=True, timeout=90, check=True)
        reply = json.loads(result.stdout)
        if reply.get('ok') is not True or reply.get('email', '').casefold() != connection['email'].casefold():
            raise ValueError('Server did not confirm registration')

    call_remote('prepare')
    directory = Path(unit_dir or Path.home() / '.config/systemd/user')
    directory.mkdir(parents=True, exist_ok=True)
    service = 'rotator-' + provider.removesuffix('-app') + '-bridge-' + digest[:12] + '.service'
    path = directory / service
    command = ['/usr/bin/ssh', '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
               '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
               '-NT', '-R', f'127.0.0.1:{remote_port}:127.0.0.1:{local_port}', host]
    label = 'Claude App' if provider == 'claude-app' else 'ChatGPT App'
    content = ('[Unit]\nDescription=' + label + ' private bridge ' + digest[:12] + ' for Lyod Rotator\n'
               'After=network-online.target\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nExecStart=' +
               ' '.join(command) + '\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n')
    changed = not path.exists() or path.read_text() != content
    if changed:
        temporary = path.with_suffix('.tmp')
        temporary.write_text(content)
        temporary.replace(path)
        subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True, capture_output=True, timeout=15)
    subprocess.run(['systemctl', '--user', 'enable', '--now', service], check=True, capture_output=True, timeout=30)
    if changed:
        subprocess.run(['systemctl', '--user', 'restart', service], check=True, capture_output=True, timeout=30)
    call_remote('register')
    return {'registered': True, 'email': connection['email']}


if __name__ == '__main__':
    try:
        payload = json.load(sys.stdin)
        print(json.dumps(register(payload['remote'], payload['connection'], provider=payload.get('provider', 'chatgpt-app'))))
    except Exception:
        # subprocess errors may contain bearer keys in stdout/stderr. Never print them.
        print('Remote registration failed; local bridge preserved.', file=sys.stderr)
        sys.exit(1)
