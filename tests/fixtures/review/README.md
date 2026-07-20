# Review Evaluation Fixtures

These repositories are deterministic, secret-free inputs for comparing a single generalist reviewer with the Chorus committee. `manifest.json` records expected categories, severity bands, acceptable source locations, clean controls, and ambiguous cases.

Expected results are product test data, not universal truth. Changes require reviewing the source fixture, explaining the changed expectation in the commit, and rerunning both review modes. Live-model evaluation is opt-in; CI uses normalized mocked reports.
