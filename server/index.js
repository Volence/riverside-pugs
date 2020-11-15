const express = require('express');
const app = express();
const cors = require('cors');
const jwt = require('jsonwebtoken')
const passport = require('passport');
const { findUser, createUser, countUsers } = require('./queries/user');
const SteamStrategy = require('passport-steam').Strategy;
const path = require('path');
const PORT = process.env.PORT || 5000;

const authRoutes = require('./routes/auth');

passport.serializeUser(function(user, done) {
  done(null, user);
});

passport.deserializeUser(function(obj, done) {
  done(null, obj);
});


app.use(express.json());
app.use(cors());
app.use(passport.initialize());
app.use(passport.session());


function getToken(id) {
  const payload = {
    id
  };

  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1hr' });
}


// Use the SteamStrategy within Passport.
//   Strategies in passport require a `validate` function, which accept
//   credentials (in this case, an OpenID identifier and profile), and invoke a
//   callback with a user object.
passport.use(new SteamStrategy({
  returnURL: 'http://localhost:3000/auth/steam/return',
  realm: 'http://localhost:3000/',
  apiKey: '0C6F3437528962A6DC3F03A416EB833E'
  },
  // function(identifier, profile, done) {
  //   User.findByOpenID({ openId: identifier }, function (err, user) {
  //     console.log('user', user)
  //     return done(err, user);
  //   });
  // }
  function (identifier, profile, done) {
    // asynchronous verification, for effect...
    process.nextTick(async function() {

      // To keep the example simple, the user's Steam profile is returned to
      // represent the logged-in user.  In a typical application, you would want
      // to associate the Steam account with a user record in your database,
      // and return that user instead.
      profile.identifier = identifier;
      const user = await findUser({id: profile.id}, ['id', 'data']);
      if(!user) {
        const newUser = await createUser({"data": profile._json, "id": profile.id});
        if(!newUser) {
          return res.status(500).json('Could not create user');
        }
      }
      return done(null, profile);
    });
  })
);

// app.use('/', [authRoutes]);

app.get('/auth/steam',
  passport.authenticate('steam', { failureRedirect: '/' }),
  function(req, res) {
    res.redirect('/');
  }
);
  
app.get('/auth/steam/return',
  // Issue #37 - Workaround for Express router module stripping the full url, causing assertion to fail 
  function(req, res, next) {
    req.url = req.originalUrl;
    next();
  }, 
  passport.authenticate('steam', { failureRedirect: '/' }),
  function(req, res) {
    const token = getToken(req.user._json.steamid);
    res.json({token, user: req.user._json, id: req.user._json.steamid});
  }
);

app.get('/auth/steamlogs', ensureAuthenticated, 
  // passport.authenticate('steam', { failureRedirect: '/' }),
  function(req, res) {
    res.send({ user: req.user });
  }
);


if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/build')));

  //after all other route definitions:
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/build/index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`)
});

function ensureAuthenticated(req, res, next) {
  console.log('req', req.isAuthenticated())
  if (req.isAuthenticated()) { return next(); }
  res.redirect('/');
}