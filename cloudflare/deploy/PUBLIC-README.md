# Local deployment configuration

The live account configuration and deployment records are intentionally excluded
from Git. The public source contains `cloudflare.config.example.ts` instead.
Existing local configuration is not changed by this privacy cleanup.

For a new installation, copy the example to `cloudflare.config.ts` and supply
`CLOUDFLARE_ACCOUNT_ID`, `PUBLIC_ORIGIN`, and `PUBLIC_CONTACT` in your environment.
`OPENAI_DOMAIN_VERIFICATION_TOKEN` is optional. Review the domain, OAuth callback,
enrollment settings, and public policies before deploying to your own account.

The ignored `.secrets.production.json` contains `CLIENT_SECRET` and `ROOT_KEY`.
Use the existing `init-secrets.mjs` only for a new installation. Never regenerate
the root key for an existing deployment, commit credentials, or force-add ignored
configuration. Keep encrypted backups outside the source repository.

Deployment uses the pinned `cf` CLI. No deployment is performed by local checks:

```sh
npm run check --prefix cloudflare
```

Do not upload the complete working directory. Private config, review records,
SQLite state, build output, archives, and credentials may exist locally even
though they are excluded from a normal Git commit.
