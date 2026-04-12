const app = require('./app');

const requestedPort = parseInt(process.env.PORT, 10) || 0;
const server = app.listen(requestedPort, () => {
  const { port } = server.address();
  console.log(`World in Wonder running at http://localhost:${port}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${requestedPort} is in use. Set a different PORT or kill the existing process.`);
    process.exit(1);
  }
  throw err;
});
