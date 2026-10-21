"""Private tunnel registration contracts; no Google/ChatGPT requests."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch, Mock

path = Path(__file__).parents[1] / 'src/providers/chatgpt-app/remote_registration.py'
spec = importlib.util.spec_from_file_location('chatgpt_registration', path)
registration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(registration)


class RegistrationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.remote = dict(sshHost='root@rotator.example', serverSessionDir='/sessions',
                           containerSessionDir='/sessions', serverConfigDir='/config',
                           apiBaseUrl='http://127.0.0.1:51201', portOffset=10000)
        self.connection = dict(email='user@example.com', baseUrl='http://127.0.0.1:3044/v1', apiKey='bridge-secret')

    def run_ok(self, command, **kwargs):
        if command[0] == 'ssh':
            payload = json.loads(kwargs['input'])
            self.assertEqual(payload['session']['baseUrl'], 'http://127.0.0.1:13044/v1')
            self.assertEqual(set(payload['session']), {'email', 'baseUrl', 'apiKey'})
            self.assertNotIn('accessToken', kwargs['input'])
            return Mock(stdout=json.dumps({'ok': True, 'email': self.connection['email']}))
        return Mock(returncode=0)

    def test_tunnel_is_loopback_only_and_repeat_does_not_restart(self):
        with patch.object(registration.subprocess, 'run', side_effect=self.run_ok) as run:
            result = registration.register(self.remote, self.connection, self.root)
            self.assertTrue(result['registered'])
            payloads = [json.loads(c.kwargs['input']) for c in run.call_args_list if c.args[0][0] == 'ssh']
            self.assertEqual([p['phase'] for p in payloads], ['prepare', 'register'])
            service = next(self.root.glob('*.service')).read_text()
            self.assertIn('-R 127.0.0.1:13044:127.0.0.1:3044', service)
            self.assertNotIn('bridge-secret', service)
            run.reset_mock()
            registration.register(self.remote, self.connection, self.root)
            self.assertFalse(any('restart' in c.args[0] for c in run.call_args_list))
            self.assertEqual(len(list(self.root.glob('*.service'))), 1)

    def test_untrusted_routes_are_rejected_before_any_command(self):
        for key, value in [('sshHost', '-oProxyCommand=evil'), ('apiBaseUrl', 'http://evil.example:80'),
                           ('serverSessionDir', '/sessions/../root'), ('portOffset', 65535)]:
            with self.subTest(key=key), patch.object(registration.subprocess, 'run') as run:
                with self.assertRaises(ValueError):
                    registration.register(dict(self.remote, **{key: value}), self.connection, self.root)
                run.assert_not_called()
        with self.assertRaises(ValueError):
            registration.validate(self.remote, dict(self.connection, baseUrl='http://evil.example:3044/v1'))

    def test_no_success_on_ssh_or_registration_failure(self):
        def fail_register(command, **kwargs):
            if command[0] == 'ssh' and json.loads(kwargs['input'])['phase'] == 'register':
                raise subprocess.CalledProcessError(1, command, stderr='private-secret')
            return self.run_ok(command, **kwargs)
        with patch.object(registration.subprocess, 'run', side_effect=fail_register):
            with self.assertRaises(subprocess.CalledProcessError):
                registration.register(self.remote, self.connection, self.root)

    def test_server_must_confirm_same_account(self):
        with patch.object(registration.subprocess, 'run', return_value=Mock(stdout='{"ok":true,"email":"other@example.com"}')):
            with self.assertRaises(ValueError):
                registration.register(self.remote, self.connection, self.root)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_embedded_server_script_compiles(self):
        compile(registration.REMOTE, '<server-registration>', 'exec')

    def test_user_bus_fallback_only_for_connection_failure(self):
        failed = subprocess.CompletedProcess([], 1, stderr=b'Failed to connect to user scope bus')
        success = subprocess.CompletedProcess([], 0, stderr=b'')
        with patch.object(registration.subprocess, 'run', side_effect=[failed, success]) as run:
            registration.systemctl_user('daemon-reload')
            self.assertEqual(run.call_count, 2)
            self.assertIn('@.host', run.call_args.args[0][2])
        denied = subprocess.CompletedProcess([], 1, stderr=b'Access denied')
        with patch.object(registration.subprocess, 'run', return_value=denied) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                registration.systemctl_user('daemon-reload')
            self.assertEqual(run.call_count, 1)

    def test_web_providers_transfer_identity_and_catalog_without_website_token(self):
        for provider in ('qwen-app', 'deepseek-app'):
            with self.subTest(provider=provider):
                connection = dict(self.connection, provider=provider, accountId='stable-account',
                                  availableModels=[dict(id='fixture', name='Fixture', thinking=True, search=False, chat=True)],
                                  token='website-secret')
                payloads = []
                def run(command, **kwargs):
                    if command[0] == 'ssh':
                        payloads.append(json.loads(kwargs['input']))
                        return Mock(stdout=json.dumps({'ok': True, 'email': connection['email']}))
                    return Mock(returncode=0)
                with patch.object(registration.subprocess, 'run', side_effect=run):
                    registration.register(self.remote, connection, self.root, provider=provider)
                self.assertEqual(payloads[-1]['session']['accountId'], 'stable-account')
                self.assertEqual(payloads[-1]['session']['provider'], provider)
                self.assertEqual(payloads[-1]['session']['availableModels'], connection['availableModels'])
                self.assertNotIn('website-secret', json.dumps(payloads))

    def test_claude_keeps_capabilities_and_uses_separate_tunnel_and_descriptor(self):
        connection = dict(self.connection, modelSelection='explicit',
                          availableModels=[{'id': 'claude-sonnet-5-5', 'efforts': ['high']}], adminApiKey='private-admin')
        payloads = []
        def run(command, **kwargs):
            if command[0] == 'ssh':
                payloads.append(json.loads(kwargs['input']))
                return Mock(stdout=json.dumps({'ok': True, 'email': connection['email']}))
            return Mock(returncode=0)
        with patch.object(registration.subprocess, 'run', side_effect=run):
            self.assertTrue(registration.register(self.remote, connection, self.root, provider='claude-app')['registered'])
        self.assertEqual(payloads[-1]['provider'], 'claude-app')
        self.assertTrue(payloads[-1]['filename'].startswith('claude-app-'))
        self.assertEqual(payloads[-1]['session']['availableModels'], connection['availableModels'])
        self.assertEqual(payloads[-1]['session']['modelSelection'], 'explicit')
        service = next(self.root.glob('rotator-claude-bridge-*.service')).read_text()
        self.assertNotIn('private-admin', service)
        self.assertNotIn('bridge-secret', service)
        with patch.object(registration.subprocess, 'run') as command:
            with self.assertRaises(ValueError):
                registration.register(self.remote, connection, self.root, provider='untrusted')
            command.assert_not_called()
