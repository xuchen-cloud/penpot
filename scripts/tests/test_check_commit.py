import importlib.machinery
import importlib.util
import pathlib
import unittest


SCRIPT = pathlib.Path(__file__).parents[1] / "check-commit"
LOADER = importlib.machinery.SourceFileLoader("check_commit", str(SCRIPT))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
CHECK_COMMIT = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(CHECK_COMMIT)


class CommitMessagePolicyTest(unittest.TestCase):
    def errors_for(self, message):
        return [name for name, ok, _ in CHECK_COMMIT.validate_message(message) if not ok]

    def test_accepts_signed_manual_commit(self):
        message = ":wrench: Align repository workflow\n\nSigned-off-by: Dev User <dev@example.com>"
        self.assertEqual([], self.errors_for(message))

    def test_accepts_signed_ai_assisted_commit(self):
        message = (
            ":wrench: Align repository workflow\n\n"
            "Signed-off-by: Dev User <dev@example.com>\n"
            "AI-assisted-by: gpt-5"
        )
        self.assertEqual([], self.errors_for(message))

    def test_rejects_subject_over_70_characters(self):
        subject = ":wrench: " + "A" * 62
        message = f"{subject}\n\nSigned-off-by: Dev User <dev@example.com>"
        self.assertIn("Subject ≤ 70 chars", self.errors_for(message))

    def test_rejects_missing_signoff(self):
        self.assertIn("DCO sign-off", self.errors_for(":books: Document workflow"))

    def test_rejects_signoff_that_does_not_match_author(self):
        message = ":books: Document workflow\n\nSigned-off-by: Other User <other@example.com>"
        errors = [
            name
            for name, ok, _ in CHECK_COMMIT.validate_message(
                message, "Signed-off-by: Dev User <dev@example.com>"
            )
            if not ok
        ]
        self.assertIn("DCO sign-off", errors)

    def test_rejects_provider_prefixed_ai_model(self):
        message = (
            ":books: Document workflow\n\n"
            "Signed-off-by: Dev User <dev@example.com>\n"
            "AI-assisted-by: openai/gpt-5"
        )
        self.assertIn("AI assistance trailer", self.errors_for(message))

    def test_pr_title_uses_the_same_70_character_policy(self):
        title = ":wrench: " + "A" * 62
        errors = [name for name, ok, _ in CHECK_COMMIT.validate_title(title) if not ok]
        self.assertIn("Subject ≤ 70 chars", errors)


if __name__ == "__main__":
    unittest.main()
