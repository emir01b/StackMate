const path = require('path');

module.exports = {
  apps: [
    {
      name:           'stackmate-landing',
      script:         './server.js',
      cwd:            __dirname,
      instances:      1,
      exec_mode:      'fork',
      watch:          false,
      autorestart:    true,
      max_restarts:   10,
      restart_delay:  3000,
      env: {
        NODE_ENV: 'production',
        PORT:     7002,
      },
      error_file: path.join(__dirname, 'logs', 'error.log'),
      out_file:   path.join(__dirname, 'logs', 'out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
