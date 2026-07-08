/**
 * pm2 process file for production: `pnpm prod` builds everything and
 * (re)starts the suite under pm2. companiond serves the built SPA from
 * apps/web/dist itself and embeds the local runner, so one process is the
 * whole suite.
 *
 * Configuration (COMPANION_HOST / COMPANION_PORT / admin credentials / …)
 * comes from companiond's layered env: process env > ./.env > ~/.companion/.env.
 *
 * To survive reboots: pm2 save && pm2 startup
 */
module.exports = {
  apps: [
    {
      name: 'companion',
      script: 'apps/companiond/dist/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 2000,
      max_restarts: 10,
      // Give run gateways time to stop on shutdown.
      kill_timeout: 10_000,
      env: {
        NODE_ENV: 'production',
      },
    },
    // A box that should ALSO execute agent work for a Companion running
    // elsewhere can serve the runner agent too — uncomment (needs
    // `pnpm --filter @moxxy/companion-runner build` or the published
    // @moxxy/companion-runner package, plus COMPANION_RUNNER_TOKEN in the env).
    // {
    //   name: 'companion-runner',
    //   script: 'apps/companion-runner/dist/index.js',
    //   cwd: __dirname,
    //   autorestart: true,
    //   kill_timeout: 10_000,
    // },
  ],
};
