import unittest

from workflow_demo import run_workflow


class WorkflowTests(unittest.TestCase):
    def test_success_waits_for_parallel_workers_and_audits_log(self):
        result = run_workflow(delay=0)
        self.assertEqual(result["status"], "done")
        self.assertTrue(result["coordinator"]["accepted"])
        self.assertTrue(result["sentinel"]["ok"])
        self.assertEqual([event["seq"] for event in result["events"]], list(range(1, 15)))

    def test_failure_keeps_other_worker_results_and_stops_before_join(self):
        result = run_workflow(fail="编辑提交员", delay=0)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["stopped_at"], "并行 worker 检查")
        self.assertEqual(sum(not worker["ok"] for worker in result["workers"]), 1)
        self.assertFalse(result["coordinator"]["accepted"])
        self.assertTrue(result["sentinel"]["ok"])


if __name__ == "__main__":
    unittest.main()
