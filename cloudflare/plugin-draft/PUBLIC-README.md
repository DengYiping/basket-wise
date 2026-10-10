# Public plugin source template

`plugin.example.json` is the publishable template. It excludes the private
walkthrough link, draft identifiers, credentials, and submission history.
The configured `basket-wise-durable/plugin.json` and private review notes remain
local and are intentionally ignored by Git.

Validate the public template from the repository root:

```sh
node cloudflare/plugin-draft/validate.mjs --template
```

On a new checkout, the validator also uses the template automatically when the
local manifest is absent. This verifies source structure, not review readiness.

To prepare your own private package, copy `plugin.example.json` to
`basket-wise-durable/plugin.json`, configure the listing and endpoint for your
app, and add your reviewer-accessible recording at
`extensions.com.openai.review.demo_recording_url`. Keep credentials exclusively
in the platform's secure reviewer fields, never in either manifest.

The existing local manifest is not replaced by this cleanup. Once configured,
run the validator without `--template`, then package only `basket-wise-durable`.
Keep the resulting archive outside that directory. Uploading a draft, submitting
it for review, publishing it, and deploying the server are separate actions.
