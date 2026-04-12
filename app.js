const express = require('express');
const path = require('path');
const { loadEnv } = require('./lib/env');
const { setupSession } = require('./lib/session');

loadEnv();

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

setupSession(app);

app.use((req, res, next) => {
  res.locals.flash = req.session.flash;
  delete req.session.flash;
  next();
});

app.use('/', require('./routes/public'));
app.use('/admin', require('./routes/admin'));
app.use('/api', require('./routes/api'));

module.exports = app;
