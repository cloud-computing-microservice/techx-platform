import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("prepare", Path(__file__).with_name("prepare-chart-release.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.manifest = {
            "commit": "a" * 40, "tag": "staging-" + "a" * 12,
            "images": [dict(component=n, image=f"{module.REGISTRY}/{n}:staging-{'a' * 12}",
                            digest="sha256:" + "b" * 64) for n in module.COMPONENTS],
        }
        self.values = "\n".join(
            f"  {workload}:\n    image:\n      repository: {module.REGISTRY}/{name}\n      tag: old"
            for name, workload in module.COMPONENTS.items())

    def test_pins_all_images_and_is_repeatable(self):
        result = module.render_values(self.values, self.manifest)
        self.assertEqual(result.count("digest: sha256:"), 3)
        self.assertEqual(module.render_values(result, self.manifest), result)

    def test_rejects_wrong_account_duplicate_missing_digest_and_tag(self):
        for mutation in ("account", "duplicate", "missing", "digest", "tag"):
            with self.subTest(mutation=mutation):
                bad = copy.deepcopy(self.manifest)
                if mutation == "account": bad["images"][0]["image"] = "other/image:tag"
                if mutation == "duplicate": bad["images"][1] = bad["images"][0]
                if mutation == "missing": bad["images"].pop()
                if mutation == "digest": bad["images"][0]["digest"] = "sha256:bad"
                if mutation == "tag": bad["tag"] = "staging-other"
                with self.assertRaises(ValueError): module.render_values(self.values, bad)

    def test_rejects_unmatched_chart_without_partial_result(self):
        with self.assertRaises(ValueError):
            module.render_values(self.values.replace("techx/order", "techx/wrong"), self.manifest)


if __name__ == "__main__":
    unittest.main()
