#!/usr/bin/env python3
"""Meaningful failure checks for observation acceptance and notification delivery."""
import contextlib, importlib.util, io, json, tempfile, unittest
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
def module(name, file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'scripts'/file)
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result

observer=module('observer','observe-infra.py')
adapter=module('adapter','dingtalk-webhook.py')
continuation=module('continuation','complete-a1-reboot.py')

class AcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.sample=json.loads((ROOT/'reports/observation-latest.json').read_text())['latest']
    def test_current_healthy_sample(self):
        self.assertEqual(observer.sample_failures(self.sample),[])
    def test_missing_sync_standby_is_unhealthy(self):
        self.sample['postgres']['streaming_standbys']=0
        self.assertIn('postgres_replication',observer.sample_failures(self.sample))
    def test_running_connector_with_failed_task_is_unhealthy(self):
        self.sample['cdc']['tasks']=['FAILED']
        self.assertIn('cdc',observer.sample_failures(self.sample))
    def test_missing_kafka_metrics_is_not_success(self):
        self.sample['monitoring']['kafka_isr']=[]
        self.assertIn('kafka_isr',observer.sample_failures(self.sample))
    def test_low_load_needs_successful_writes(self):
        self.sample['phase']='low-load'
        self.assertIn('synthetic_writes',observer.sample_failures(self.sample))
    def test_backup_staleness(self):
        self.sample['backup']['completed_epoch']=self.sample['epoch']-31*3600
        self.assertIn('backup',observer.sample_failures(self.sample))
    def test_dingtalk_http_success_with_api_error_is_failure(self):
        payload={'status':'firing','alerts':[{'labels':{'alertname':'Test'}}]}
        with patch.object(adapter,'config',return_value={'webhook':'https://oapi.dingtalk.com/robot/send?access_token=test'}),patch.object(adapter.urllib.request,'urlopen') as urlopen:
            urlopen.return_value.__enter__.return_value=io.StringIO('{"errcode":310000}')
            with self.assertRaises(RuntimeError):adapter.deliver(payload)
    def test_dingtalk_recovery_acceptance(self):
        payload={'status':'resolved','alerts':[{'labels':{'alertname':'Test','acceptance_id':'unique-test'}}]}
        output=io.StringIO()
        with patch.object(adapter,'config',return_value={'webhook':'https://oapi.dingtalk.com/robot/send?access_token=test','secret':'SECtest'}),patch.object(adapter.urllib.request,'urlopen') as urlopen,contextlib.redirect_stdout(output):
            urlopen.return_value.__enter__.return_value=io.StringIO('{"errcode":0}')
            adapter.deliver(payload)
            request=urlopen.call_args.args[0]
            self.assertIn('&sign=',request.full_url)
            sent=json.loads(request.data)
            self.assertIn('恢复',sent['markdown']['title'])
        result=json.loads(output.getvalue());self.assertEqual(result['test_ids'],['unique-test']);self.assertTrue(result['delivered'])
    def test_reboot_report_from_another_drill_cannot_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);state=root/'state';state.mkdir();(root/'reports').mkdir()
            (state/'pending.json').write_text(json.dumps({'old_boot_id':'expected-old'}))
            with patch.object(continuation,'ROOT',root),patch.object(continuation,'STATE',state),patch.object(continuation,'current_boot_id',return_value='new-boot'),patch.object(continuation,'systemctl'),patch.object(continuation,'remote_report',return_value={'status':'PASS','old_boot_id':'unrelated-old','new_boot_id':'new-boot'}):
                with self.assertRaises(RuntimeError):continuation.main()
            report=json.loads((root/'reports/a1-reboot-validation.json').read_text())
            self.assertEqual(report['status'],'FAIL');self.assertTrue((state/'failed.json').exists())
    def test_same_boot_does_not_consume_request(self):
        with tempfile.TemporaryDirectory() as directory:
            state=Path(directory);(state/'pending.json').write_text(json.dumps({'old_boot_id':'unchanged'}))
            with patch.object(continuation,'STATE',state),patch.object(continuation,'current_boot_id',return_value='unchanged'),patch.object(continuation,'remote_report') as remote,contextlib.redirect_stdout(io.StringIO()):
                continuation.main();remote.assert_not_called()
            self.assertTrue((state/'pending.json').exists())
    def test_successful_reboot_preserves_previous_observation(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);state=root/'state';state.mkdir();reports=root/'reports';reports.mkdir();obs=root/'observation';obs.mkdir()
            (state/'pending.json').write_text(json.dumps({'old_boot_id':'old'}))
            (obs/'samples.jsonl').write_text('old-samples\n');(obs/'started.json').write_text('{}')
            (reports/'observation-latest.json').write_text('{}')
            (reports/'node-reboot-validation.json').write_text(json.dumps({'nodes':[]}))
            (reports/'DEPLOYMENT-PROGRESS.md').write_text('')
            (root/'OPERATIONS.md').write_text('');(root/'DEPLOYMENT-CHECKLIST.md').write_text('| INFRA-29 | reboot | PARTIAL | pending |\n')
            smoke=type('Result',(),{'returncode':0,'stdout':b'{"outbox":{"status":"PASS"},"clickhouse":"PASS","temporal":"PASS"}'})()
            with patch.object(continuation,'ROOT',root),patch.object(continuation,'STATE',state),patch.object(continuation,'OBS',obs),patch.object(continuation,'current_boot_id',return_value='new'),patch.object(continuation,'systemctl'),patch.object(continuation,'remote_report',return_value={'status':'PASS','old_boot_id':'old','new_boot_id':'new'}),patch.object(continuation.subprocess,'run',return_value=smoke),patch.object(continuation.urllib.request,'urlopen') as urlopen:
                urlopen.return_value.__enter__.return_value=io.StringIO('{"health":"true"}')
                continuation.main()
            report=json.loads((reports/'a1-reboot-validation.json').read_text())
            self.assertEqual(report['status'],'PASS');self.assertTrue((state/'completed.json').exists())
            self.assertEqual((Path(report['previous_observation_archive'])/'samples.jsonl').read_text(),'old-samples\n')
            self.assertIn('| PASS |',(root/'DEPLOYMENT-CHECKLIST.md').read_text())

if __name__=='__main__':unittest.main()
