const Tenant = require('../models/Tenant');
const { RESERVED_SLUGS } = require('../utils/helpers');

const BASE_DOMAIN = (process.env.BASE_DOMAIN || 'localhost').toLowerCase();
const MAIN_HOSTS = new Set([BASE_DOMAIN, `www.${BASE_DOMAIN}`, 'localhost', '127.0.0.1']);

/*
 * Finds the turf for a subdomain such as royalturf.squareturf.com
 * and puts it on req.publicTenant. Other hosts continue untouched.
 */
module.exports = async (req, res, next) => {
  const host = (req.hostname || '').toLowerCase();

  if (MAIN_HOSTS.has(host)) return next();

  const suffix = `.${BASE_DOMAIN}`;
  if (!host.endsWith(suffix)) return next();

  const slug = host.slice(0, -suffix.length);
  if (!slug || RESERVED_SLUGS.has(slug)) return next();

  try {
    const tenant = await Tenant.findOne({ slug, isPublished: true }).lean();

    if (!tenant) {
      return res.status(404).render('error', {
        title: 'Turf not found',
        message: 'This turf website is unavailable.'
      });
    }

    req.publicTenant = tenant;
    next();
  } catch (error) {
    next(error);
  }
};