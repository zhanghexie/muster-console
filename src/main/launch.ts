// Choose the entry synchronously: product protocols have to register before ready.
// In offline replay and delete modes the workbench's startup code must never run.
if (process.argv.some(arg => ['--demo-build', '--demo-run', '--demo-delete'].includes(arg))) {
  require('./demo.js');
} else {
  require('./workbench.js');
}
