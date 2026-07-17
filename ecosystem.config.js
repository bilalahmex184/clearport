module.exports = {
  apps: [{
    name: 'clearport',
    script: 'node_modules/.bin/next',
    args: 'start -p 3000',
    max_memory_restart: '1200M',
    exp_backoff_restart_delay: 100,
    min_uptime: '10s',
    max_restarts: 20,
    env: { NODE_ENV: 'production' },
  }],
};
