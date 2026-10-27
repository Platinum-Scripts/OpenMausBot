import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("ticket", Path(__file__).with_name("omb-pcc-ticket.py"))
ticket = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ticket)


class TicketWorkflowTest(unittest.TestCase):
    def test_remote_json_roundtrip_and_dedupe(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            capture = root / "received.json"
            sentinel = root / "shell-expanded"
            (root / "fo.py").write_text('''import json,os
from pathlib import Path
def file_issue(company,title,body,key,**kwargs):
    p=Path(os.environ["CAPTURE"])
    previous=json.loads(p.read_text()) if p.exists() else None
    data=dict(company=company,title=title,body=body,key=key,kwargs=kwargs)
    if previous: assert previous==data
    p.write_text(json.dumps(data))
    return "PCC-123"
''')
            title = f'''Failure "quoted" $(touch {sentinel}) `touch {sentinel}` ' apostrophe'''
            body = "First line\nSecond line with $HOME and Unicode: café\n"
            real_run = subprocess.run

            def transport(command, **kwargs):
                self.assertEqual(command[:4], ["sudo", "-u", "maus", "ssh"])
                self.assertEqual(command[-2], "ops@factory.invalid")
                self.assertNotIn(title, command[-1])
                self.assertEqual(kwargs["timeout"], 300)
                return real_run(["bash", "-c", command[-1].replace("/opt/factory-ops", directory)],
                                **kwargs, env={**os.environ, "CAPTURE": str(capture)})

            with patch.object(ticket.subprocess, "run", side_effect=transport):
                self.assertEqual(ticket.file_ticket(title, body, "ops@factory.invalid"), "PCC-123")
                self.assertEqual(ticket.file_ticket(title, body, "ops@factory.invalid"), "PCC-123")
            saved = json.loads(capture.read_text())
            self.assertEqual(saved["title"], title)
            self.assertEqual(saved["body"], body)
            self.assertEqual(saved["company"], "PCC")
            self.assertRegex(saved["key"], r"^omb-fork-update-\d{4}-\d{2}-\d{2}$")
            self.assertEqual(saved["kwargs"], {"dedupe_minutes": 720})
            self.assertFalse(sentinel.exists())

    def test_no_false_receipt_or_diagnostic_leak(self):
        cases = [(0, "None"), (0, "create_failed:0"), (0, ""), (0, "PCC-123\nunexpected"),
                 (255, "PCC-123"), (0, "MIA-123")]
        for code, output in cases:
            with self.subTest(code=code, output=output):
                result = subprocess.CompletedProcess([], code, output, "fixture-private-diagnostic")
                stdout, stderr = io.StringIO(), io.StringIO()
                with patch.object(ticket.subprocess, "run", return_value=result), \
                     patch.dict(os.environ, {"FACTORY_SSH": "ops@factory.invalid"}), \
                     patch.object(ticket.sys, "argv", ["ticket", "title"]), \
                     patch.object(ticket.sys, "stdin", io.StringIO("body")), \
                     contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    self.assertEqual(ticket.main(), 1)
                self.assertEqual(stdout.getvalue(), "")
                self.assertNotIn("fixture-private-diagnostic", stderr.getvalue())
                self.assertIn("unconfirmed", stderr.getvalue())

    def test_timeout_and_missing_configuration_do_not_retry(self):
        with patch.object(ticket.subprocess, "run") as run:
            for destination in ["", "-oProxyCommand=bad", "ops@host;command"]:
                with self.assertRaises(ValueError):
                    ticket.file_ticket("title", "body", destination)
            run.assert_not_called()
        with patch.object(ticket.subprocess, "run", side_effect=subprocess.TimeoutExpired("ssh", 300)) as run:
            with self.assertRaises(subprocess.TimeoutExpired):
                ticket.file_ticket("title", "body", "ops@factory.invalid")
            self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
