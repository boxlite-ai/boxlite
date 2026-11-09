// Explicit fixtures for modules that load configuration during import.
process.env.TURNSTILE_SITEKEY = 'registration-test-sitekey'
process.env.TURNSTILE_SECRET_KEY = 'registration-test-secret'
process.env.TURNSTILE_EXPECTED_HOSTNAMES = 'dashboard.example.test'
