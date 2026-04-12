const serverlessExpress = require('@codegenie/serverless-express');
const app = require('./app');

let handler;

exports.handler = async (event, context) => {
  console.log('EVENT:', JSON.stringify(event, null, 2));
  try {
    if (!handler) {
      handler = serverlessExpress({ app });
    }
    const response = await handler(event, context);
    console.log('RESPONSE status:', response.statusCode, 'body length:', response.body ? response.body.length : 0);
    return response;
  } catch (err) {
    console.error('Lambda handler error:', err);
    return {
      statusCode: 500,
      body: 'Internal Server Error',
    };
  }
};
