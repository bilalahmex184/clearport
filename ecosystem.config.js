module.exports = {
  apps: [
    {
      name: 'clearport',
      script: 'node_modules/.bin/next',
      args: 'start -p 3000',
      max_memory_restart: '1200M',
      exp_backoff_restart_delay: 100,
      min_uptime: '10s',
      max_restarts: 20,
      env: { NODE_ENV: 'production' },
    },
    {
      // Pipeline worker — polls processing_jobs table and runs extraction +
      // validation. Decouples upload from the CPU-intensive extraction pipeline.
      name: 'clearport-worker',
      script: 'mini-services/worker/index.ts',
      interpreter: 'bun',
      max_memory_restart: '800M',
      exp_backoff_restart_delay: 1000,
      min_uptime: '5s',
      max_restarts: 20,
      env: { NODE_ENV: 'production' },
    },
  ],
};
