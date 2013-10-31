var debug = require('debug')('snow:ripple:federation')
, request = require('request')
, parseUrl = require('url').parse

var errorMessages = {
    'noSuchUser': 'The supplied user was not found.',
    'noSuchDomain': 'The supplied domain is not served here.',
    'invalidParams': 'Missing or conflicting parameters.',
    'unavailable': 'Service is temporarily unavailable.'
}

module.exports = exports = function(app) {
    exports.app = app
    app.get('/ripple/federation', exports.handler)
}

exports.sendError = function(res, query, name) {
    res.send({
        result: 'error',
        error: name,
        error_message: errorMessages[name] || 'Unknown error',
        query: query
    })
}

exports.handler = function(req, res, next) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}$/.exec(req.query.domain)) {
        debug('domain %s is invalid', req.query.domain)
        return exports.sendError(res, req.query, 'invalidParams')
    }

    if (!/^\S+$/.exec(req.query.user)) {
        debug('username %s is invalid', req.query.user)
        return exports.sendError(res, req.query, 'invalidParams')
    }

    var domain = req.query.domain.toLowerCase()
    , user = req.query.user.toLowerCase()

    debug('processing lookup for %s@%s', user, domain)

    // The domain name is served directly here
    if (req.query.domain.toLowerCase() == req.app.config.ripple_federation.domain) {
        return exports.fromUser(user, function(err, tag) {
            if (err) return next(err)
            if (!tag) return exports.sendError(res, req.query, 'noSuchUser')
            res.send({
                result: 'success',
                federation_json: {
                    type: 'federation_record',
                    user: user,
                    tag: tag,
                    service_address: req.app.config.ripple_account,
                    domain: domain
                }
            })
        })
    }

    if (!req.app.config.ripple_federation.forward) {
        return exports.sendError(res, req.query, 'noSuchDomain')
    }

    debug('forwarding request for %s', domain)

    exports.forward(req, res, next)
}

exports.fromUser = function(user, cb) {
    var query = {
        text: 'SELECT tag FROM "user" WHERE REPLACE(email_lower, \'@\', \'_\') = $1',
        values: [user]
    }

    exports.app.conn.read.query(query, function(err, dr) {
        if (err) return cb(err)
        if (!dr.rowCount) return cb()
        cb(null, dr.rows[0].tag)
    })
}

exports.lookupDomain = function(domain, cb) {
    request({
        url: 'http://' + domain + '/ripple.txt'
    }, function(err, res, data) {
        if (err) return cb(err)
        if (res.statusCode != 200) return cb()

        var match = /\[federation_url\]\n(.[^\n]+)/i.exec(data)
        if (!match) return cb(new Error('Federation url not found'))

        cb(null, parseUrl(match[1]).href)
    })
}

exports.forward = function(req, res, next) {
    exports.lookupDomain(req.query.domain, function(err, url) {
        if (err) return next(err)

        if (!url) {
            return exports.sendError(res, req.query, 'noSuchDomain')
        }

        request({
            url: url,
            qs: {
                type: 'federation',
                user: req.query.user,
                domain: req.query.domain
            },
            json: true
        }, function(err, rres, body) {
            if (err) return next(err)
            if (rres.statusCode != 200) return next(new Error('Status ' + rres.statusCode))
            return res.send(body)
        })
    })
}