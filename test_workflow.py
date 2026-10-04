import unittest

from workflow_demo import run_workflow


class WorkflowTests(unittest.TestCase):
    def test_success_has_software_phases_and_stable_graph(self):
        result = run_workflow(delay=0)
        self.assertEqual(result["status"], "done")
        self.assertTrue(result["coordinator"]["accepted"])
        self.assertTrue(result["sentinel"]["ok"])
        self.assertEqual([phase["discipline"] for phase in result["phases"]], [
            "Software Requirements", "Software Design", "Software Construction",
            "Software Testing", "Software Maintenance",
        ])
        graph = result["graph"]
        self.assertEqual(len(graph["nodes"]), len({node["id"] for node in graph["nodes"]}))
        self.assertTrue(all(node["state"] == "done" for node in graph["nodes"]))
        self.assertEqual([event["seq"] for event in result["events"]], list(range(1, len(result["events"]) + 1)))

    def test_failure_preserves_partial_results_and_blocks_downstream(self):
        result = run_workflow(fail="证据审查员", delay=0)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["stopped_at_id"], "design")
        self.assertEqual(sum(not actor["ok"] for actor in result["actors"]), 1)
        self.assertEqual(result["phases"][2]["state"], "pending")
        self.assertEqual(result["phases"][2]["blocked_by"], "design")
        self.assertTrue(result["sentinel"]["ok"])
        self.assertEqual(result["graph"]["statuses"]["phases"]["design"], "failed")


if __name__ == "__main__":
    unittest.main()
