const User = require('../models/User');
const { nextStepPath } = require('../utils/onboarding');

const renderDenied = (res, message) =>
  res.status(403).render('error', { title: 'Access denied', message });

exports.requireAuth = async (req, res, next) => {
  if (!req.session.userId) return res.redirect('/login');

  try {
    const user = await User.findById(req.session.userId).populate('tenant');

    if (!user) {
      return req.session.destroy(() => res.redirect('/login'));
    }

    req.user = user;
    res.locals.currentUser = user;
    next();
  } catch (error) {
    next(error);
  }
};

/* Owner pages: finish sign-up first if it is not complete */
exports.requireOwner = (req, res, next) => {
  if (!req.user || req.user.role !== 'owner') {
    return renderDenied(res, 'An owner account is required.');
  }

  const unfinished = nextStepPath(req.user, req.user.tenant);
  if (unfinished) return res.redirect(unfinished);

  next();
};

exports.requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return renderDenied(res, 'Administrator access required.');
  }
  next();
};