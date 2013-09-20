var assert = require('assert')
, debug = require('debug')('snow:security:demand')
, format = require('util').format

module.exports = exports = function(app) {
    exports.app = app
    return exports
}

var types = ['any', 'trade', 'deposit', 'withdraw', 'primary', 'admin']
types.forEach(function(type) {
    exports[type] = function(req, res, next) {
        if (typeof req == 'number') {
            return exports.handler.bind(exports, type, req || 0)
        }

        exports.handler(type, 0, req, res, next)
    }
})

exports.handler = function() {
    return exports.demand.apply(this, arguments)
}

exports.demand = function(type, level, req, res, next) {
    if (!req.user) {
        debug('user is not set, demand has failed')
        return res.send(401, {
            name: 'NotAuthenticated',
            message: 'Both API key and session cookie missing'
        })
    }

    debug('demanding type %s and level %s', type, level)

    assert((req.apikey && !req.session) || (!req.apikey && req.session))
    assert.equal(typeof req.user, 'object')

    if (req.user.suspended) {
        return res.send(401, {
            name: 'UserSuspended',
            message: 'The user is suspended. Contact support'
        })
    }

    if (req.session && req.user.tfaSecret && !req.session.tfaPassed &&
        req.path != '/v1/twoFactor/auth')
    {
        debug('session is primary, user has 2fa enabled, but 2fa is not passed')
        return res.send(401, {
            name: 'OtpRequired',
            message: 'Two-factor authentication is required for this account'
        })
    }

    if ((type == 'primary' || type == 'admin') && !req.session) {
        debug('required type is primary, but request uses api key')

        return res.send(401, {
            name: 'SessionRequired',
            message: 'The action requires an interactive session'
        })
    }

    assert.equal(typeof req.user.securityLevel, 'number')

    if (req.user.securityLevel < level) {
        debug('security level %d is lower than required %d', req.user.securityLevel, level)

        return res.send(401, {
            name: 'SecurityLevelTooLow',
            message: 'The user\'s security level is too low'
        })
    }

    if (type == 'admin' && !req.user.admin) {
        return res.send(401, {
            name: 'UserNotAdmin',
            message: 'User is not admin'
        })
    }

    if (req.apikey && !~['any', 'primary'].indexOf(type)) {
        var mapping = {
            trade: 'canTrade',
            withdraw: 'canWithdraw',
            deposit: 'canDeposit'
        }[type]

        assert(mapping, 'mapping not found for type ' + type)

        debug('apikey %j is missing required permission %s (%s)', req.apikey, type, mapping)

        if (!req.apikey[mapping]) {
            return res.send(401, {
                name: 'PermissionRequired',
                message: format('The API key does not have the %s permission', type)
            })
        }
    }

    if (!req.session) return next()

    debug('session has %ds left', Math.round((req.session.expires - new Date()) / 1e3))
    debug('extending session...')
    exports.app.security.session.extend(req.cookies.session, function(err) {
        if (err) {
            console.error('Failed to extend session:')
            console.error(err)
        }
        debug('session extended')
        next()
    })
}