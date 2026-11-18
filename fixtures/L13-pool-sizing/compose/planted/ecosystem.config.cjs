module.exports = {
  apps: [{ name: 'api', script: 'src/server.js', instances: 2, exec_mode: 'cluster' }],
};
