// Enable users to log in via a login form on the site at `/login`.
//
// ## Options
//
// `loginUrl`
//
// alternative login url, if this is not present, the login route is `/login`
//
// `localLogin`
//
// If explicitly set to `false`, the `/login` route does not exist,
// and it is not possible to log in via your username and password.
// This usually makes sense only in the presence of an alternative such as
// the `apostrophe-passport` module, which adds support for login via
// Google, Twitter, gitlab, etc.
//
// `passwordMinLength`
//
// The minimum length for passwords. You should set this, as there
// is no default for bc reasons (effectively the default is `1`).
//
// `passwordRules`
//
// An optional array of password rule names, as strings. The standard rules
// available are `noSlashes`, `noSpaces`, `mixedCase`, `digits`, and
// `noTripleRepeats`. The `noTripleRepeats` rule forbids repeating a
// character three times in a row. By default no rules are in effect.
//
// When this option is set, the rules are consulted when a password
// is set or reset. Existing passwords that do not follow the rules
// are tolerated. If you wish to enforce them for existing passwords
// as well, see below.
//
// `resetLegacyPassword`
//
// By default, password rules are enforced only when a password is
// being set or reset. If you wish, you can set `resetLegacyPassword: true`
// to require users to reset their password on the spot if it is
// correct but does not meet the current rules. However if you are able
// to enable the email-based `passwordReset: true` option that
// is slightly more secure because it requires proof of ownership of the
// email address as well as the old password. You can combine that with
// `passwordRulesAtLoginTime`, below.
//
// `passwordRulesAtLoginTime`
//
// By default, password rules are enforced only when a password is
// being set or reset. Setting this option to `true` will apply
// the rules at login time, so that even an existing password will
// not work unless it passes the rules. This can be useful if you don't
// mind a few irritated users and you have enabled
// the email-based `passwordReset: true`. However this requires
// email delivery to work (see below), so you may be more comfortable
// with `resetLegacyPassword: true` (above).
//
// `passwordReset`
//
// If set to `true`, the user is given the option to reset their password,
// provided they can receive a confirmation email. Not available if `localLogin` is `false`.
// Email delivery must work, which requires more configuration; see [sending email with ApostropheCMS](/devops/email.md).
//
// `passwordResetHours`
//
// When `passwordReset` is `true`, this option controls how many hours
// a password reset request remains valid. If the confirmation email is not
// acted upon in time, the user must request a password reset again.
// The default is `48`.
//
// `resetKnownPassword`
//
// This option allows the user to change their password, provided they know
// their current password. This is helpful, but it does not help uers who have
// forgotten their passwords. For that, you should enable `passwordReset`
// (see above for concerns). You should bear in mind that this option is not as
// secure as requiring confirmation via email with `passwordReset.
//
// `throttle`
//
// If the `throttle` option is set to `{ allowedAttempts: 3, perMinutes: 1, lockoutMinutes: 10 }` for
// this module then no more than three failed attempts per minute are permitted
// for the same account, after which the user is locked out for 10 minutes. If
// `throttle` exists, `allowedAttempts` defaults to 3, `perMinutes` defaults to 1,
// and `lockoutMinutes` also defaults to 1.
//
// `totp`
//
// If this option is set to `true`, the user will be required to set up two-factor
// authentication via Google Authenticator or a compatible app (TOTP) on their
// next successful login, and all future logins will require the verification code.
//
// If this option is set to an object, you may specify sub-options:
//
// `totp: { groups: true }`
//
// The `groups` sub-option indicates that TOTP is only required for groups
// for which it has been activated. This usually only makes sense when the
// `groups` option for the `apostrophe-user` module is *not* set, allowing
// administrators to edit the configuration for groups, make new ones, and
// check the box to require TOTP.
//
// ## Notable properties of apos.modules['apostrophe-login']
//
// `passport`
//
// Apostrophe's instance of the [passport](https://npmjs.org/package/passport) npm module.
// You may access this object if you need to implement additional passport "strategies."
//
// ## Promise events
//
// ### after
//
// The promise event `after` is emitted after login succeeds. This
// is a good place to set `req.redirect` to the URL of your choice. If no module sets
// `req.redirect`, the newly logged-in user is redirected to the home page. The
// event handler receives `req`.
//
// ### `before`
//
// The promise event `before` is emitted by the `/login` route,
// before any attempt is made to evaluate the login. It receives `req`. If it
// throws a string as an error, that string is internationalized and reported
// to the user as the login error message. This is useful to implement modules
// like `apostrophe-login-recaptcha`.
//
// ### `deserialize`
//
// The promise event `deserialize` is emitted on every HTTP request by a
// logged-in user. It receives `user`, the object found in the database for
// this user. This event is used, for instance, to fetch group information
// related to the user. To avoid degrading the editing experience handlers
// for this event should be as fast as possible.

var Passport = require('passport').Passport;
var LocalStrategy = require('passport-local');
var TotpStrategy = require('passport-totp').Strategy;
var base32 = require('thirty-two');
var _ = require('@sailshq/lodash');
var qs = require('qs');
var Promise = require('bluebird');
var async = require('async');
var moment = require('moment');

module.exports = {

  alias: 'login',

  singletonWarningIfNot: 'apostrophe-login',

  afterConstruct: function(self) {
    self.enableSerializeUsers();
    self.enableDeserializeUsers();

    if (self.options.localLogin !== false) {
      self.enableLocalStrategy();
      if (self.options.totp) {
        self.enableTotp();
      }
    }

    self.enableMiddleware();
    self.addRoutes();
    self.pushAssets();
    self.addAdminBarItems();
    self.pushCreateSingleton();
  },

  construct: function(self, options) {

    self.passport = new Passport();

    // Set the `serializeUser` method of `passport` to serialize the
    // user by storing their user ID in the session.

    self.enableSerializeUsers = function() {
      self.passport.serializeUser(function(user, done) {
        done(null, user._id);
      });
    };

    self.randomKey = function(len) {
      var buf = [];
      var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      var charlen = chars.length;

      for (var i = 0; i < len; ++i) {
        buf.push(chars[self.getRandomInt(0, charlen - 1)]);
      }

      return buf.join('');
    };

    self.getRandomInt = function(min, max) {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    };

    // Set the `deserializeUser` method of `passport` to
    // deserialize the user by locating the appropriate
    // user via the [apostrophe-users](/reference/modules/apostrophe-users)
    // module. Then invokes the `loginDeserialize` method of
    // every module that has one, passing the `user` object. These
    // methods may optionally take a callback.

    self.enableDeserializeUsers = function() {
      self.passport.deserializeUser(self.deserializeUser);
    };

    // Given a user's `_id`, fetches that user via the login module
    // and, if the user is found, invokes the `loginDeserialize`
    // method of all modules that have one via `callAll`.
    // Then invokes the callback with `(null, user)`.
    //
    // If the user is not found, invokes the callback with
    // `(null, null)` (NOTE: no error in the first argument).
    //
    // If another error occurs, it is passed as the first argument.
    //
    // This method is passed to `passport.deserializeUser`.
    // It is also useful when you wish to load a user exactly
    // as Passport would.

    self.deserializeUser = function(id, callback) {
      var req = self.apos.tasks.getReq();
      return self.apos.users.find(req, { _id: id }).toObject(function(err, user) {
        if (err) {
          return callback(err);
        }
        if (!user) {
          return callback(null, null);
        }
        return self.callAllAndEmit('loginDeserialize', 'deserialize', user, function(err) {
          return callback(err, err ? null : user);
        });
      });
    };

    // On every request, immediately after the user has been fetched,
    // build the `user._permissions` object which has a simple
    // boolean property for each permission the user possesses.
    //
    // Permissions can be obtained either via the group or via the
    // user object itself, although there is currently no interface for
    // adding permissions directly to a user.
    //
    // `admin` implies `edit`, and `edit` implies `guest`. These
    // are populated accordingly.
    //
    // If you have `admin-` rights for any specific content types,
    // you are also granted `guest` and `edit` (create) permissions for other
    // types that are not restricted to admins only.

    self.loginDeserialize = function(user) {
      user._permissions = {};
      _.each(user._groups, function(group) {
        _.each(group.permissions || [], function(permission) {
          user._permissions[permission] = true;
        });
      });
      _.each(user.permissions || [], function(permission) {
        user._permissions[permission] = true;
      });
      // The standard permissions are progressive
      if (user._permissions.admin) {
        user._permissions.edit = true;
      }
      if (user._permissions.edit) {
        user._permissions.guest = true;
      }

      // If you are admin- for any type of content, you need to be
      // at least guest to effectively attach media to your content,
      // and the edit permission also makes sense because it does not
      // immediately let you do anything, just makes it easier to see
      // you are a candidate to do things like edit pages if given
      // specific rights to them. Also simplifies outerLayout's logic
      if (self.apos.permissions.options.typeAdminsCanEditAllTypes !== false) {
        if (_.some(user._permissions, function(val, key) {
          return key.match(/^admin-/);
        })) {
          user._permissions.guest = true;
          user._permissions.edit = true;
        }
      }
    };

    // Adds the "local strategy" (username/email and password login)
    // to Passport. Users are found via the `find` method of the
    // [apostrophe-users](/reference/modules/apostrophe-users) module.
    // Users with the `disabled` property set to true may not log in.
    // Passwords are verified via the `verifyPassword` method of
    // [apostrophe-users](/reference/modules/apostrophe-users), which is
    // powered by the [credential](https://npmjs.org/package/credential) module.

    self.enableLocalStrategy = function() {
      self.passport.use(new LocalStrategy(self.verifyLogin));
    };

    self.enableTotp = function() {
      self.passport.use(new TotpStrategy(self.verifyTotp));
    };

    // Verify a login attempt. `username` can be either
    // the username or the email address (both are unique).
    //
    // If a system-level failure occurs, such that we don't
    // know if the user's login should have succeeded,
    // then the first argument to the callback is an error.
    //
    // If the user's login FAILS, the first argument is
    // is `null`, and the second argument is `false` (no user).
    //
    // If the user's login SUCCEEDS, the first argument
    // is `null` and the second argument is the user object.
    //
    // PLEASE NOTE THAT A USER FAILING TO LOG IN
    // **DOES NOT** REPORT AN ERROR as the first callback
    // argument. You MUST check the second argument.
    //
    // The convention is set this way for compatibility
    // with `passport`.

    self.verifyLogin = function(username, password, callback) {
      var req = self.apos.tasks.getReq();
      return self.apos.users.find(req, {
        $or: [
          { username: username },
          { email: username }
        ],
        disabled: { $ne: true }
      }).toObject(function(err, user) {
        if (err) {
          return callback(err);
        }
        if (!user) {
          // Slow down and keep 'em hanging to make brute force attacks less easy
          return setTimeout(function () {
            return callback(null, false);
          }, 1000);
        }
        return self.verifyPassword(user, password, function(err) {
          if (err) {
            // Slow down and keep 'em hanging to make brute force attacks less easy
            return setTimeout(function () {
              // string error = OK to pass on to browser (like "throttle")
              if ((typeof err) === 'string') {
                return callback(err);
              } else {
                return callback(null, false);
              }
            }, 1000);
          }
          return self.checkIfActive(user, callback);
        });
      });
    };

    // Verify the given password by checking it against the
    // hash in the safe. The callback is invoked with an error
    // on failure, otherwise with `null`.
    //
    // `user` is an `apostrophe-user` doc. If `options.throttle` is set to
    // `{ allowedAttempts: 3, perMinutes: 1, lockoutMinutes: 10 }` for this module then no more than three failed
    // attempts per minute are permitted for the same account, after which the user is locked out
    // for 10 minutes. If `options.throttle` exists, `perMinutes` defaults to
    // 1 minute, `lockoutMinutes` also defaults to 1 minute, and `allowedAttempts` must
    // be specified.

    self.verifyPassword = function(user, password, callback) {
      let { allowedAttempts = 3, perMinutes = 1, lockoutMinutes = 1 } = self.options.throttle || {};
      const safe = self.apos.users.safe;

      // Implementation is an async function, but the interface is a legacy callback.
      // Never return a promise so no one gets the wrong idea
      Promise.try(body).then(function() {
        callback(null);
        return null;
      }).catch(function(err) {
        return callback(err);
      });

      async function body(callback) {
        await throttleAttempts();
        await attempt();
      }

      async function throttleAttempts() {
        if (self.options.throttle) {
          const userSafe = await safe.findOne({
            _id: user._id
          });
          const lockoutSince = getLockoutSince();
          if (userSafe.lockout && (userSafe.lockout >= lockoutSince)) {
            throw 'throttle';
          }
        }
      }

      async function attempt() {
        const verify = Promise.promisify(self.apos.users.verifyPassword);
        try {
          await verify(user, password);
        } catch (e) {
          let err = e;
          await addAttempt();
          if (await lockoutIfNeeded()) {
            err = 'throttle';
          }
          await cleanUpAttempts();
          throw err;
        }
      }

      async function addAttempt() {
        if (!self.options.throttle) {
          return;
        }
        return safe.update({
          _id: user._id
        }, {
          $push: {
            attempts: new Date()
          }
        });
      }

      async function lockoutIfNeeded() {
        const userSafe = await safe.findOne({
          _id: user._id
        });
        const perSince = getPerSince();
        if (userSafe.attempts && userSafe.attempts.filter(attempt => (attempt >= perSince)).length >= allowedAttempts) {
          await safe.update({
            _id: user._id
          }, {
            $set: {
              lockout: new Date()
            }
          });
          return true;
        }
      }

      async function cleanUpAttempts() {
        const perSince = getPerSince();
        await safe.update({
          _id: user._id
        }, {
          $pull: {
            attempts: {
              $lt: perSince
            }
          }
        });
      }

      function getPerSince() {
        return new Date(Date.now() - perMinutes * 60 * 1000);
      }

      function getLockoutSince() {
        return new Date(Date.now() - lockoutMinutes * 60 * 1000);
      }

    };

    self.verifyTotp = function(user, done) {
      return self.apos.users.safe.findOne({
        _id: user._id
      }).then(function(userSafe) {
        return self.checkIfActive(userSafe, function(err) {
          if (err) {
            return done(err);
          }
          return done(null, userSafe && userSafe.totp && userSafe.totp.key, userSafe && userSafe.totp && userSafe.totp.period);
        });
      }).catch(function(err) {
        return done(err);
      });
    };

    self.disableIfInactive = function(user) {
      if (self.apos.users.options.disableInactiveAccounts) {
        var usersOptions = self.apos.users.options.disableInactiveAccounts;
        if (user.lastLogin) {
          // by default, "admin" users are not disabled
          var isUserNeverDisabled = user._groups.some(function(group) {
            return usersOptions.neverDisabledGroups.includes(group.title);
          });
          if (!isUserNeverDisabled) {
            var lastLogin = moment(user.lastLogin);
            var now = moment();
            var diff = now.diff(lastLogin, 'days');
            if (diff >= usersOptions.inactivityDuration) {
              return self.apos.docs.db.update({ _id: user._id }, { $set: { disabled: true, trash: false, lastLogin: null } })
                .then(function() {
                  user.disabled = true;
                  return user;
                }).catch(function(err) {
                  self.apos.utils.error(err);
                  return err;
                });
            }
          }
        }
      }

      return new Promise(function(resolve) {
        resolve(user);
      });
    };

    self.checkIfActive = function(user, callback) {
      return self.disableIfInactive(user).then(function(updatedUser) {
        if (updatedUser.disabled) {
          return callback({ message: 'Account disabled due to inactivity. Please, refer to the administrator of the site for assistance.' }, false);
        }
        callback(null, updatedUser);
        return null; // avoid Bluebird warning about Promise not returned
      }).catch(function(err) {
        return callback(err, false);
      });
    };

    // Add Passport's initialize and session middleware.
    // Also add middleware to add the `req.data.user` property.
    // Now works via the expressMiddleware property, allowing
    // control of timing relative to other modules.

    self.enableMiddleware = function() {
      self.expressMiddleware = [
        self.passport.initialize(),
        self.passport.session()
      ].concat(self.options.totp ? [ self.requireTotp ] : [])
        .concat([
          self.addUserToData
        ]);
    };

    // If the user is logged in, require that they also have
    // totp, otherwise kick them over to get it
    self.requireTotp = function(req, res, next) {
      if (!req.user) {
        return next();
      }
      if (!self.totpNeeded(req)) {
        return next();
      }
      var safelist = [ '/login-totp', '/setup-totp', '/confirm-totp', '/login', '/logout' ];
      if (_.contains(safelist, req.url)) {
        return next();
      }
      if (!req.session.totp) {
        if (req.url.indexOf('.') !== -1) {
          // Allow 404'ing asset URLs to work normally,
          // but don't let anything sneak through with req.user attached
          delete req.user;
          return next();
        } else {
          return res.redirect('/login-totp');
        }
      }
      return next();
    };

    self.totpNeeded = function(req) {
      if (!req.user) {
        return false;
      }
      if (self.options.totp.groups) {
        return !!(req.user._groups || []).find(group => group.totp);
      } else {
        return true;
      }
    };

    // return the loginUrl option
    self.getLoginUrl = function() {
      return self.options.loginUrl ? self.options.loginUrl : "/login";
    };

    // Add the `/login` route, both GET (show the form) and POST (submit the form).
    // Also add the `/logout` route.

    self.addRoutes = function() {
      if (self.options.localLogin !== false) {
        self.apos.app.get(self.getLoginUrl(), function(req, res) {
          if (req.user) {
            // User is already logged in, redirect to home page
            return res.redirect('/');
          }
          req.scene = 'user';
          // message is supported as a simple way of delivering all errors
          // but we also provide `errors` for templates that wish to do more
          return self.sendPage(req, 'login', { passwordReset: self.options.passwordReset, message: getMessage(), errors: req.query.errors });
          function getMessage() {
            if (req.query.message) {
              return req.query.message;
            }
            if (req.query.errors && req.query.errors.length) {
              return req.query.errors.join(' ');
            }
          }
        });

        self.apos.app.post('/login',
          async function(req, res, next) {
            try {
              await self.emit('before', req);
              return next();
            } catch (e) {
              return res.redirect(`${self.getLoginUrl()}?` + qs.stringify({
                errors: [ req.__ns('apostrophe', ((typeof e) === 'string') ? e : 'An error occurred.') ],
                // bc
                error: '1'
              }));
            }
          },
          function(req, res, next) {
            if (!(self.options.passwordRulesAtLoginTime || self.options.resetLegacyPassword)) {
              return next();
            }
            var password = req.body.password;
            var errors = self.checkPasswordRules(req, password);
            if (errors.length) {
              if (self.options.resetLegacyPassword) {
                // If the password is inadequate, check to see if it is
                // the correct legacy password for the user. If it is,
                // allow them to fix it
                return self.verifyLogin(req.body.username, password, function(err, user) {
                  if (err || (!user)) {
                    if (err === 'throttle') {
                      errors.unshift(req.__ns_n('apostrophe', 'Too many login attempts. You may try again in %s minute(s).', self.options.throttle.lockout));
                    }
                    return fail(errors);
                  }
                  req.session.resetLegacyPasswordId = user._id;
                  var reset;
                  return Promise.try(function() {
                    reset = self.apos.utils.generateId();
                    user.passwordReset = reset;
                    user.passwordResetAt = new Date();
                    return self.apos.users.update(req, user, { permissions: false }).then(function() {
                      return user;
                    });
                  }).then(function(user) {
                    return res.redirect('/password-reset?' + qs.stringify({
                      reset: reset,
                      errors: [ res.__ns('apostrophe', 'Your password must be changed for the following reasons:') ].concat(errors)
                    }));
                  }).catch(function(err) {
                    self.apos.utils.error(err);
                    return fail(errors);
                  });
                });
              } else {
                return fail(errors);
              }
            }
            return next();
            function fail(errors) {
              return res.redirect(`${self.getLoginUrl()}?` + qs.stringify({
                errors: errors,
                // bc
                error: '1'
              }));
            }
          },
          function(req, res, next) {
            self.passport.authenticate('local', function(err, user, info) {
              if (err) {
                if (err === 'throttle') {
                  // verifyPassword does not take req, so we i18n the error here
                  //
                  // Use of __ns_n means that the "minute(s)" string can be pluralized
                  // more nicely if desired via i18n json config, even for English
                  err = new Error(req.__ns_n('apostrophe', 'Too many failed login attempts. You may try again in %s minute(s).', self.options.throttle.lockout));
                }
                return res.redirect(`${self.getLoginUrl()}?` + qs.stringify({
                  message: err.message,
                  error: '1'
                }));
              }
              if (!user) {
                return res.redirect(`${self.getLoginUrl()}?` + qs.stringify({
                  message: req.__ns('apostrophe', 'Incorrect login or password or account disabled'),
                  error: '1'
                }));
              }
              req.logIn(user, function(err) {
                if (err) {
                  return next(err);
                }
                return next();
              });
            })(req, res, next);
          },
          self.afterLogin
        );
      }

      if ((self.options.localLogin !== false) && self.options.passwordReset) {

        self.apos.app.get('/password-reset-request', function(req, res) {
          if (req.user) {
            // User is already logged in, redirect to home page
            return res.redirect('/');
          }
          req.scene = 'user';
          req.data.loginUrl = self.getLoginUrl();
          // Gets i18n'd in the template, also bc with what templates that tried to work
          // before certain fixes would expect (this is why we still pass a string and not
          // a flag, and why we call it `message`)
          return self.sendPage(req, 'passwordResetRequest', { error: req.query.error });
        });

        self.apos.app.post('/password-reset-request', function(req, res) {
          var username = self.apos.launder.string(req.body.username);
          if (!username.length) {
            return res.redirect('/password-reset-request?error=missing');
          }
          var clauses = [];
          clauses.push({ username: username });
          clauses.push({ email: username });
          return self.apos.users.find(req, {
            $or: clauses
          }).permission(false).toObject().then(function(user) {
            if (!user) {
              throw 'notfound';
            }
            return self.sendPasswordResetEmail(req, user);
          }).then(function() {
            return res.redirect(`${self.getLoginUrl()}?` + qs.stringify({ message: 'An email message has been sent to you with instructions to reset your password. Be sure to check your spam folder if you do not see it in the next few minutes.' }));
          }).catch(function(err) {
            self.apos.utils.error(err);
            return res.redirect('/password-reset-request?error=error');
          });
        });

      }

      if ((self.options.localLogin !== false) && (self.options.passwordReset || self.options.resetLegacyPassword)) {

        self.apos.app.get('/password-reset', function(req, res) {
          var reset = self.apos.launder.string(req.query.reset);
          var email = self.apos.launder.string(req.query.email);
          if (!reset.length) {
            return res.redirect('/password-reset-request?error=missing');
          }
          req.scene = 'user';
          var adminReq = self.apos.tasks.getReq();
          var criteria = {
            passwordResetAt: { $gte: new Date(Date.now() - self.getPasswordResetLifetimeInMilliseconds()) }
          };

          if (req.session.resetLegacyPasswordId) {
            criteria._id = req.session.resetLegacyPasswordId;
          } else {
            criteria.email = email;
          }

          return self.apos.users.find(adminReq, criteria).toObject().then(function(user) {
            if (!user) {
              delete req.session.resetLegacyPasswordId;
              throw 'notfound';
            }
            req.data.loginUrl = self.getLoginUrl();
            return self.sendPage(req, 'passwordReset', { reset: reset, email: email, message: getMessage(), errors: req.query.errors });
          }).catch(function(err) {
            self.apos.utils.error(err);
            return res.redirect(`${self.getLoginUrl()}?message=${req.__ns('apostrophe', 'That reset code was not found. It may have expired. Try resetting again.')}`);
          });

          function getMessage() {
            if (req.query.message) {
              return req.query.message;
            }
            if (req.query.errors && req.query.errors.length) {
              return req.query.errors.join(' ');
            }
          }
        });

        self.apos.app.post('/password-reset', function(req, res) {
          var reset = self.apos.launder.string(req.body.reset);
          var email = self.apos.launder.string(req.body.email);
          var password = self.apos.launder.string(req.body.password);
          var password2 = self.apos.launder.string(req.body.password2);
          if (!reset.length) {
            return res.redirect('/password-reset?' + qs.stringify({
              errors: [ 'The password reset code is missing from your link. Try resetting your password again.' ],
              email: email,
              reset: reset
            }));
          }
          if (!password.length) {
            return res.redirect('/password-reset?' + qs.stringify({
              errors: [ 'You did not enter a new password.' ],
              email: email,
              reset: reset
            }));
          }
          if (password !== password2) {
            return res.redirect('/password-reset?' + qs.stringify({
              errors: [ 'The passwords do not match.' ],
              email: email,
              reset: reset
            }));
          }
          var errors = self.checkPasswordRules(req, password);
          if (errors.length) {
            return res.redirect('/password-reset?' + qs.stringify({
              errors: errors,
              email: email,
              reset: reset
            }));
          }
          var adminReq = self.apos.tasks.getReq();
          var criteria = {
            passwordResetAt: { $gte: new Date(Date.now() - self.getPasswordResetLifetimeInMilliseconds()) }
          };
          if (req.session.resetLegacyPasswordId) {
            criteria._id = req.session.resetLegacyPasswordId;
          } else {
            criteria.email = email;
          }
          return Promise.try(function() {
            return self.apos.users.find(adminReq, criteria).toObject();
          }).then(function(user) {
            if (!user) {
              delete req.session.resetLegacyPasswordId;
              throw new Error('notfound');
            }
            return self.apos.users.verifySecret(user, 'passwordReset', reset).then(function() {
              return user;
            });
          }).then(function(user) {
            user.password = password;
            delete user.passwordResetAt;
            return self.apos.users.update(adminReq, user);
          }).then(function(user) {
            return self.apos.users.forgetSecret(user, 'passwordReset');
          }).then(function(user) {
            return res.redirect(`${self.getLoginUrl()}?message=${req.__ns('apostrophe', 'Your password has been reset. Please log in.')}`);
          }).catch(function(err) {
            self.apos.utils.error(err);
            return res.redirect('/password-reset?errors[]=error');
          });
        });

      }

      self.getPasswordResetLifetimeInMilliseconds = function() {
        return 1000 * 60 * 60 * (self.options.passwordResetHours || 48);
      };

      if (self.options.resetKnownPassword) {
        self.renderRoute('post', 'reset-known-password-modal', function(req, res, next) {
          return next(null, {
            template: 'resetKnownPassword'
          });
        });
        self.apiRoute('post', 'reset-known-password', function(req, res, next) {
          const existingPassword = self.apos.launder.string(req.body.existingPassword);
          const newPassword = self.apos.launder.string(req.body.newPassword);
          if (!(existingPassword.length && newPassword.length)) {
            return next('required');
          }
          return async.series([
            verify,
            reset
          ], function(err) {
            if (err) {
              return next(err);
            }
            self.apos.notify(req, 'Your password has been updated.', { type: 'success' });
            return next();
          });

          function verify(callback) {
            return self.verifyPassword(req.user, existingPassword, callback);
          }

          function reset(callback) {
            req.user.password = newPassword;
            return self.apos.users.update(req, req.user, {
              permissions: false
            }, callback);
          }
        });
      }

      if (self.options.totp) {

        self.apos.app.get('/setup-totp', getTotp, function(req, res) {
          if (!req.user) {
            return res.redirect(self.getLoginUrl());
          }
          if (req.totp && req.totp.confirmed) {
            return res.redirect('/login-totp');
          }

          var encodedKey;
          var period = (req.totp && req.totp.period) || 30;
          var otpUrl;
          var qrImage;

          var key = (req.totp && req.totp.key) || self.randomKey(10);

          req.scene = 'user';
          encodedKey = base32.encode(key);

          otpUrl = 'otpauth://totp/' + req.user.username + '?secret=' + encodedKey + '&period=' + period;
          qrImage = 'https://chart.googleapis.com/chart?chs=166x166&chld=L|0&cht=qr&chl=' + encodeURIComponent(otpUrl);

          return self.apos.users.safe.update({
            _id: req.user._id
          }, {
            $set: {
              totp: {
                key: key,
                period: period
              }
            }
          }, function(err) {
            // Do not show misleading UI
            delete req.user;
            if (err) {
              return res.status(500).send('Error saving TOTP options to user');
            } else {
              return self.sendPage(req, 'setup-totp', { key: encodedKey, qrImage: qrImage });
            }
          });
        });

        self.apos.app.post('/confirm-totp', getTotp, function(req, res) {
          if (!req.user) {
            return res.redirect(self.getLoginUrl());
          }
          if (!req.totp) {
            return res.redirect('/setup-totp');
          }
          return self.apos.users.safe.update({
            _id: req.user._id
          }, {
            $set: {
              'totp.confirmed': true
            }
          }, function(err) {
            if (err) {
              self.apos.utils.error(err);
              return res.redirect('/logout');
            }
            return res.redirect('/login-totp');
          });
        });

        self.apos.app.get('/login-totp', getTotp, function(req, res) {
          if (!req.user) {
            return res.redirect(self.getLoginUrl());
          }
          if (!(req.totp && req.totp.confirmed)) {
            return res.redirect('/setup-totp');
          }
          // Do not show misleading UI
          delete req.user;
          req.scene = 'user';
          return self.sendPage(req, 'login-totp', { error: req.query.error });
        });

        self.apos.on('csrfExceptions', function(list) {
          list.push('/login-totp');
          list.push('/confirm-totp');
        });

        self.apos.app.post('/login-totp', function(req, res, next) {
          // People type the space shown in the app a lot
          req.body.code = self.apos.launder.string(req.body.code);
          req.body.code = req.body.code.replace(/\s+/g, '');
          return next();
        }, self.passport.authenticate('totp', {
          failureRedirect: '/login-totp?error=1'
        }), function(req, res) {
          req.session.totp = true;
          return self.afterLogin(req, res);
        });

      }

      // Middleware used by totp, can't be inside the if statement
      // because of eslint rules

      function getTotp(req, res, next) {
        if (!req.user) {
          return next();
        }
        return self.apos.users.safe.findOne({
          _id: req.user._id
        }, {
          totp: 1
        }).then(function(safeUser) {
          if (!safeUser) {
            return next();
          }
          req.totp = safeUser.totp;
          return next();
        }).catch(function(err) {
          self.apos.utils.error(err);
          return res.status(500).send('error');
        });
      };

      self.apos.app.get('/logout', function(req, res) {
        // Completely destroy the session. req.logout only breaks
        // the association with the user. Our end users expect
        // a more secure logout that leaves no trace.
        return req.session.destroy(function(err) {
          if (err) {
            // Not much more we can do, but it will be apparent to the user
            // that they are still logged in
            self.apos.utils.error(err);
          }
          res.redirect('/');
        });
      });
    };

    // Send a password reset email, with a magic link to a one-time-use
    // form to reset the password, to the given `user`. Returns
    // a promise; when that promise resolves the email has been
    // handed off for delivery (not necessarily received).
    //
    // NOTE: the promise will be rejected if the user has no
    // `email` property to which to send an email.

    self.sendPasswordResetEmail = function(req, user) {
      var site = (req.headers['host'] || '').replace(/:\d+$/, '');
      var url;
      var reset;
      return Promise.try(function() {
        reset = self.apos.utils.generateId();
        user.passwordReset = reset;
        user.passwordResetAt = new Date();
        return self.apos.users.update(req, user, { permissions: false }).then(function() {
          return user;
        });
      }).then(function(user) {
        if (!user.email) {
          throw new Error('no email');
        }
        var parsed = require('url').parse(req.absoluteUrl);
        parsed.pathname = '/password-reset';
        parsed.query = { reset: reset, email: user.email };
        delete parsed.search;
        url = require('url').format(parsed);
        return self.email(req, 'passwordResetEmail', { user: user, url: url, site: site }, {
          to: user.email,
          subject: req.res.__ns('apostrophe', self.options.passwordResetSubject || ('Your request to reset your password on ' + site))
        });
      });
    };

    // Add the `user` property to `req.data` when a user is logged in.

    self.addUserToData = function(req, res, next) {
      if (req.user) {
        req.data.user = req.user;
        return next();
      } else {
        return next();
      }
    };

    // Push the login stylesheet.

    self.pushAssets = function() {
      self.pushAsset('stylesheet', 'always', { when: 'always' });
      self.pushAsset('stylesheet', 'user', { when: 'user' });
      self.pushAsset('script', 'user', { when: 'user' });
      self.pushAsset('script', 'reset-known-password-modal', { when: 'user' });
    };

    self.addAdminBarItems = function() {
      var items = [];
      var key;
      if (self.options.resetKnownPassword) {
        key = self.__meta.name + '-reset-known-password';
        self.apos.adminBar.add(key, 'Change Password', null);
        items.push(key);
      }
      key = self.__meta.name + '-logout';
      self.apos.adminBar.add(key, 'Log Out', null, { last: true, href: '/logout' });
      items.push(key);
      if (items.length > 1) {
        self.apos.adminBar.group({
          label: 'Account',
          items: items,
          last: true
        });
      }
    };

    // Invoked by passport after an authentication strategy succeeds
    // and the user has been logged in. Invokes `loginAfterLogin` on
    // any modules that have one and redirects to `req.redirect` or,
    // if it is not set, to `/`.

    self.afterLogin = function(req, res) {

      if (self.options.totp) {
        if ((!req.session.totp) && self.totpNeeded(req)) {
          return res.redirect('/login-totp');
        }
      }

      var user = Object.assign({}, req.user, { lastLogin: new Date() });
      return self.apos.users.update(req, user, { permissions: false })
        .then(function() {
          return self.callAllAndEmit('loginAfterLogin', 'after', req, function(err) {
            if (err) {
              self.apos.utils.error(err);
              return res.redirect('/');
            }

            req.redirect = req.redirect || '/';
            return res.redirect(req.redirect);
          });
        }).catch(function(err) {
          self.apos.utils.error(err);
          req.redirect = req.redirect || '/';
          return res.redirect(req.redirect);
        });
    };

    // Returns an array of error messages, which will be
    // empty if there are no errors. The error messages
    // will be internationalized for you.

    self.checkPasswordRules = function(req, password) {
      var errors = [];
      var minLength = self.options.passwordMinLength || 1;
      if (password.length < minLength) {
        errors.push('Passwords must be at least ' + minLength + ' characters long.');
      }
      if (self.options.passwordRules) {
        _.each(self.options.passwordRules, function(name) {
          var rule = self.passwordRules[name];
          if (!rule.test(password)) {
            errors.push(rule.message);
          }
        });
      }
      errors = errors.map(function(error) {
        return req.__ns('apostrophe', error);
      });
      return errors;
    };

    self.passwordRules = {
      noSlashes: {
        test: function(password) {
          return !((password.indexOf('/') !== -1) || (password.indexOf('\\') !== -1));
        },
        message: '/ and \\ characters are not allowed in passwords.'
      },
      noSpaces: {
        test: function(password) {
          return !password.match(/\s/);
        },
        message: 'Spaces are not allowed in passwords.'
      },
      mixedCase: {
        test: function(password) {
          return password.match(/[a-z]/) && password.match(/[A-Z]/);
        },
        message: 'Passwords must contain both uppercase and lowercase characters.'
      },
      digits: {
        test: function(password) {
          return password.match(/\d/);
        },
        message: 'Passwords must contain digits.'
      },
      noTripleRepeats: {
        test: function(password) {
          var i;
          for (i = 0; (i < (password.length - 2)); i++) {
            var char0 = password.charAt(i);
            var char1 = password.charAt(i + 1);
            var char2 = password.charAt(i + 2);
            if ((char0 === char1) && (char0 === char2)) {
              return false;
            }
          }
          return true;
        },
        message: 'No character may be repeated three times in a row in a password.'
      }
    };

    // Register a password validation rule. Does not
    // activate it, see the passwordRules option.
    // `name` is a unique name to be included in the
    // `passwordRules` option array, `test` is a function
    // that accepts the password and returns `true` only
    // if the password passes the rule, and `message`
    // is a short message to be shown to the user in the
    // event the rule fails, which will automatically be
    // internationalized for you.

    self.addPasswordRule = function(name, test, message) {
      self.passwordRules[name] = {
        test: test,
        message: message
      };
    };

    self.modulesReady = function() {
      // So this property is hashed and the hash kept in the safe,
      // rather than ever being stored literally
      self.apos.users.addSecret('passwordReset');
    };

  }
};
