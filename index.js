var config = require('konfu')
, express = require('express')
, app = express()
, http = require('http')
, server = http.createServer(app)
, conn = require('./db')(config.pg_url, config.pg_native)
, Cache = require('./cache')

var auth = require('./auth')(conn)

app.config = config

app.use(express.bodyParser())

var routes = ['balances', 'markets', 'orders', 'ripple',
'currencies', 'activities', 'users', 'transfer',
'bitcoincharts', 'intercom']
routes.forEach(function(name) {
    require('./' + name).configure(app, conn, auth)
})

require('./bitcoin').configure(app, conn, auth, 'BTC')
require('./bitcoin').configure(app, conn, auth, 'LTC')

app.use(function(req, res) {
    res.send(404)
})

if (config.raven) {
    var raven = require('raven')
    app.use(raven.middleware.express(config.raven))
}

var cache = new Cache(conn, function(err) {
    if (err) throw err
    app.cache = cache

    server.listen(config.port)
})
