// Serves the static site; sends www and plain http to https://getrelay.fun.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === 'www.getrelay.fun' || url.protocol === 'http:') {
      url.hostname = 'getrelay.fun';
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
