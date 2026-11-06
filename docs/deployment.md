# Deploy to Netlify

Import this repository into your Netlify team and use the repository root as the base directory. The build settings live in `netlify.toml`. Choose a plan and spending limits before enabling builds. Each production build applies the framework and application migrations to the configured database.

## Configure the first release

1. Create a **new PostgreSQL database** for this site. Set `DATABASE_URL` in the production context for builds and functions. If your provider requires an unpooled migration URL, set `DATABASE_URL_UNPOOLED` for the same database. Remove any conflicting Netlify Database integration variables. Keep production credentials out of previews, local runs and branches.
2. Generate a random `BETTER_AUTH_SECRET` of at least 32 characters in a password manager. Save it in Netlify for production builds and functions and keep it stable between releases. Set `BETTER_AUTH_URL` to the public HTTPS origin. Keep authentication enabled and leave `VITEST` unset.
3. For evidence classification and debate runs, configure a fresh `OPENROUTER_API_KEY` in the server's secret settings. Configure `OPENALEX_API_KEY` when authenticated literature search is needed. Keep these values out of Git and browser environment variables.
4. Deploy the production branch. Confirm that the release check, build and migration command all succeed. Check the generated HTTPS address in a signed-out browser. Sign in, create a test claim, reload it, then check from a second account that the claim stays private. Use the verified URL as the public app link.

## Check the host's request limit

Debates run synchronously. Three sequential model requests can take up to 270 seconds plus database time. Confirm that your host, plan and reverse proxy support a request lasting at least 300 seconds before advertising live debates. If they cut off earlier, use a long-running Node host with persistent PostgreSQL, or implement a durable debate worker before releasing that feature. A timed-out request can leave an active Run. Read the saved history before starting another.

The free-model restriction applies to evidence classification and the three debate roles. The general Agent-Native chat has separate provider settings. Configure those before inviting users.

[Netlify environment variables](https://docs.netlify.com/build/environment-variables/overview/) · [Netlify Functions](https://docs.netlify.com/build/functions/overview/)
