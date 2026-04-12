const serverlessExpress = require('@codegenie/serverless-express');
const app = require('./app');

let handler;

exports.handler = (event, context) => {
  if (!handler) {
    handler = serverlessExpress({ app });
  }
  return handler(event, context);
};
