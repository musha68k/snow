/* global TropoWebAPI, TropoJSON */
var _ = require('lodash')
, Tropo = require('tropo')
, debug = require('debug')('snow:users')
, libphonenumber = require('libphonenumber')

require('tropo-webapi')

module.exports = exports = function(app) {
    app.get('/v1/whoami', app.security.demand.any, exports.whoami)
    app.post('/v1/users/identity', app.security.demand.primary(2), exports.identity)
    app.post('/v1/users/verify/text', app.security.demand.primary(1), exports.startPhoneVerify)
    app.post('/v1/users/verify/call', app.security.demand.primary(1), exports.voiceFallback)
    app.post('/v1/users/verify', app.security.demand.primary(1), exports.verifyPhone)
    app.post('/tropo', exports.tropoHandler)
    app.patch('/v1/users/current', app.security.demand.primary, exports.patch)
    app.post('/v1/changePassword', app.security.demand.otp(app.security.demand.primary, true), exports.changePassword)

    exports.tropo = new Tropo({
        voiceToken: app.config.tropo_voice_token,
        messagingToken: app.config.tropo_messaging_token
    })

    require('./users.create')(app)
}

exports.patch = function(req, res, next) {
    if (!req.app.validate(req.body, 'v1/user_patch', res)) return

    var updates = {}
    , values = [req.user.id]

    if (req.body.language !== undefined) {
        updates['language'] = req.body.language
    }

    if  (req.body.username !== undefined) {
        updates['username'] = req.body.username
    }

    var updateText = _.map(updates, function(value, key) {
        values.push(value)
        return key + ' = $' + values.length
    })

    if (values.length == 1) {
        return res.send(400, {
            name: 'NoUpdates',
            message: 'No updates were provided'
        })
    }

    req.app.conn.write.query({
        text: [
            'UPDATE "user"',
            'SET ' + updateText,
            'WHERE user_id = $1'
        ].join('\n'),
        values: values
    }, function(err, dr) {
        if (err) return next(err)
        if (!dr.rowCount) {
            return next(new Error('User ' + req.user.id + ' not found'))
        }
        req.app.security.invalidate(req.user.id)
        res.send(204)
    })
}

exports.whoami = function(req, res, next) {
    // TODO: extract to view
	req.app.conn.read.query({
		text: [
            'SELECT',
            '   user_id id,',
            '   email,',
            '   admin,',
            '   tag,',
            '   phone_number phone,',
            '   first_name firstname,',
            '   last_name lastname,',
            '   address,',
            '   country,',
            '   postal_area postalarea,',
            '   language,',
            '   security_level,',
            '   two_factor,',
            '   username,',
            '   city',
            'FROM user_view',
            'WHERE user_id = $1'
        ].join('\n'),
		values: [req.user.id]
	}, function(err, dres) {
		if (err) return next(err)
		if (!dres.rows.length) return res.send(404)
        // PostgreSQL is not case sensitive. Case sensitive naming must be done here
        // and not using "AS".
        var row = dres.rows[0]
		res.send({
            id: row.id,
            email: row.email,
            admin: row.admin,
            tag: row.tag,
            phone: row.phone,
            firstName: row.firstname,
            lastName: row.lastname,
            username: row.username,
            address: row.address,
            country: row.country,
            postalArea: row.postalarea,
            city: row.city,
            securityLevel: row.security_level,
            language: row.language,
            twoFactor: !!row.two_factor
        })
	})
}

exports.identity = function(req, res, next) {
    if (!req.app.validate(req.body, 'v1/user_identity', res)) return

    var query = {
        text: [
            'UPDATE "user"',
            'SET',
            '   first_name = $2,',
            '   last_name = $3,',
            '   address = $4,',
            '   country = $5,',
            '   city = $6,',
            '   postal_area = $7',
            'WHERE',
            '   user_id = $1 AND',
            '   first_name IS NULL'
        ].join('\n'),
        values: [req.user.id, req.body.firstName, req.body.lastName, req.body.address,
            req.body.country, req.body.city, req.body.postalArea]
    }

    req.app.conn.write.query(query, function(err, dr) {
        if (err) {
            return next(err)
        }

        if (!dr.rowCount) {
            return res.send(404, {
                name: 'IdentityAlreadySet',
                message: 'The identity for the user has already been set.'
            })
        }

        req.app.security.invalidate(req.user.id)
        req.app.intercom.setIdentity(req.user.id, req.body)

        req.app.activity(req.user.id, 'IdentitySet', {})

        return res.send(204)
    })
}

exports.verifyPhone = function(req, res, next) {
    // As soon as he attempts to solve, the user may not fall back
    // to a voice call
    delete exports.allowedVoiceFallback[req.user.id]

    req.app.conn.write.query({
        text: 'SELECT verify_phone($1, $2) success',
        values: [req.user.id, req.body.code]
    }, function(err, dr) {
        if (err) {
            if (err.message == 'User already has a verified phone number.') {
                return res.send(400, {
                    name: 'AlreadyVerified',
                    message: 'A phone number has already been verified for this user'
                })
            }

            if (err.message == 'User has not started phone verification') {
                return res.send(400, {
                    name: 'NotInPhoneVerify',
                    message: 'The user has not begun phone verification'
                })
            }

            return next(err)
        }

        if (!dr.rows[0].success) {
            return res.send(403, {
                name: 'VerificationFailed',
                message: 'Verification failed. The code is wrong.'
            })
        }

        req.app.security.invalidate(req.user.id)

        req.app.conn.read.query({
            text: [
                'SELECT phone_number',
                'FROM "user"',
                'WHERE user_id = $1'
            ].join('\n'),
            values: [req.user.id]
        }, function(err, dr) {
            if (err) return console.error(err)
            req.app.intercom.setUserPhoneVerified(req.user.id, dr.rows[0].phone_number)
        })

        res.send(204)
    })
}

exports.allowedVoiceFallback = {}

exports.voiceFallback = function(req, res, next) {
    var item = exports.allowedVoiceFallback[req.user.id]

    if (!item) {
        return res.send(400, {
            name: 'CallFallbackNotAllowed',
            message: 'User is not in a situation where he can fallback to voice'
        })
    }

    delete exports.allowedVoiceFallback[req.user.id]

    debug('falling back to voice for user %s', req.user.id)

    var codeMsg = [
        '<prosody rate=\'-5%\'>',
        'Your code is:' ,
        '</prosody>',
        '<prosody rate=\'-20%\'>',
        item.code.split('').join(', '),
        '.</prosody>'
    ].join('')

    var msg = [
        '<speak>',
        '<prosody rate=\'-5%\'>',
        'Welcome to Just-coin.',
        '</prosody>',
        codeMsg,
        codeMsg,
        '</speak>'
    ].join('')

    exports.tropo.call(item.number, msg, function(err) {
        if (err) return next(err)
        res.send(204)
    })
}

exports.startPhoneVerify = function(req, res, next) {
    if (!req.app.validate(req.body, 'v1/user_verify_call', res)) return

    debug('processing request to start phone verification %j', req.body)

    var number

    try {
        number = libphonenumber.e164(req.body.number, req.body.country)
    } catch (e) {
        debug('failed to parse %s (%s): %s', req.body.country, req.body.number,
            e.message || e)

        return res.send(400, {
            name: 'InvalidPhoneNumber',
            message: 'The number is not a valid phone number'
        })
    }

    req.app.conn.write.query({
        text: 'SELECT create_phone_number_verify_code($2, $1) code',
        values: [req.user.id, number]
    }, function(err, dr) {
        if (err) {
            if ((/^User is locked out/i).exec(err.message)) {
                return res.send(403, {
                    name: 'LockedOut',
                    message: err.message
                })
            }

            if (err.message.match(/User already has a verified phone number/)) {
                return res.send(400, {
                    name: 'PhoneAlreadyVerified',
                    message: 'User already has a verified phone number'
                })
            }

            if (err.message == 'Another user has already verified that phone number.') {
                return res.send(403, {
                    name: 'PhoneNumberInUse',
                    message: err.message
                })
            }

            return next(err)
        }

        var code = dr.rows[0].code

        debug('correct code is %s', code)

        exports.allowedVoiceFallback[req.user.id] = {
            code: code,
            number: number
        }

        debug('requesting text to %s', number)

        var msg = code + ' is your Justcoin code'

        exports.tropo.message(number, msg, function(err) {
            if (err) return next(err)
            res.send(200, {
                number: number
            })
        })
    })
}

exports.tropoHandler = function(req, res) {
    var params = req.body.session.parameters

    debug('processing tropo request with params %j', params)

    var method

    if (params.token == req.app.config.tropo_messaging_token) {
        method = 'message'
    }

    if (params.token == req.app.config.tropo_voice_token) {
        method = 'call'
    }

    if (!method) {
        debug('invalid tropo token %s', params.token)
        return res.send(400)
    }

    var tropo = new TropoWebAPI()

    if (method == 'call') {
        tropo.call(params.numberToDial)
        tropo.wait(2000)
        tropo.say(params.msg)
    } else {
        tropo.call(params.number, null, null, null, null, null, 'SMS', null, null, null)
        tropo.say(params.msg)
    }

    var tropoJSON = TropoJSON(tropo)

    debug('sending tropo response %s', tropoJSON)

    res.send(tropoJSON)
}

exports.changePassword = function(req, res, next) {
    if (!req.app.validate(req.body, 'v1/users_changepassword', res)) return

    req.app.conn.write.query({
        text: [
            'UPDATE api_key',
            'SET api_key_id = $2',
            'WHERE user_id = $1 AND "primary" = TRUE'
        ].join('\n'),
        values: [req.user.id, req.body.key]
    }, function(err) {
        if (err) return next(err)
        req.app.activity(req.user.id, 'ChangePassword', {})
        res.send(204)
        req.app.security.invalidate(req.user.id)
    })
}
