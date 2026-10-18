const User = require('../models/User');

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

exports.requireOwner = (req, res, next) => {
  if (!req.user || req.user.role !== 'owner' || !req.user.tenant) {
    return renderDenied(res, 'An owner account is required.');
  }
  next();
};

exports.requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return renderDenied(res, 'Administrator access required.');
  }
  next();
};