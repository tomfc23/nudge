/*
 * Page behaviour: copy-to-clipboard, scrolled nav, provider-wall parallax, and
 * rewriting the placeholder install host to wherever this page is served from
 * so the one-liner actually works on a preview deploy.
 */
(function () {
  "use strict";

  var SITE_PLACEHOLDER = "https://nudge.tommyek.com";

  /* ---------- install command host ---------- */
  var local = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(location.hostname);
  var origin = local ? location.origin : SITE_PLACEHOLDER;

  document.querySelectorAll("[data-install-cmd]").forEach(function (node) {
    if (origin === SITE_PLACEHOLDER) return;
    node.textContent = node.textContent.split(SITE_PLACEHOLDER).join(origin);
  });

  /* ---------- copy ---------- */
  function legacyCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (error) {
      ok = false;
    }
    document.body.removeChild(area);
    return ok;
  }

  document.querySelectorAll("[data-install]").forEach(function (box) {
    var button = box.querySelector("[data-copy]");
    var status = box.querySelector("[data-copy-status]");
    var command = box.querySelector("[data-install-cmd]");
    if (!button || !command) return;

    var reset = 0;

    function announce(state, message) {
      button.dataset.state = state;
      button.textContent = state === "copied" ? "Copied" : state === "error" ? "Select" : "Copy";
      if (status) status.textContent = message;
      clearTimeout(reset);
      reset = setTimeout(function () {
        delete button.dataset.state;
        button.textContent = "Copy";
        if (status) status.textContent = "";
      }, 2600);
    }

    button.addEventListener("click", function () {
      var text = command.textContent.trim();

      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(
          function () {
            announce("copied", "Install command copied to the clipboard.");
          },
          function () {
            announce(legacyCopy(text) ? "copied" : "error", "Copying failed. Select the command and copy it manually.");
          },
        );
        return;
      }

      var fallback = legacyCopy(text);
      announce(
        fallback ? "copied" : "error",
        fallback
          ? "Install command copied to the clipboard."
          : "Copying failed. Select the command and copy it manually.",
      );
    });
  });

  /* ---------- nav ---------- */
  var nav = document.querySelector("[data-nav]");
  if (nav) {
    var onScroll = function () {
      nav.classList.toggle("is-scrolled", window.scrollY > 12);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    // The fixed header wraps at narrow widths, so its height is not a constant.
    // Publish the measured height as --nav-h for scroll-padding-top and the
    // hero's top padding.
    var markNavHeight = function () {
      document.documentElement.style.setProperty(
        "--nav-h",
        Math.round(nav.getBoundingClientRect().height) + "px",
      );
    };
    if (window.ResizeObserver) new ResizeObserver(markNavHeight).observe(nav);
    markNavHeight();
  }

  /* ---------- provider wall parallax ---------- */
  var field = document.querySelector("[data-parallax]");
  var hero = document.querySelector(".hero");
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  var fine = window.matchMedia("(hover: hover) and (pointer: fine)");

  if (field && fine.matches && !reduce.matches) {
    var targetX = 0;
    var targetY = 0;
    var currentX = 0;
    var currentY = 0;
    var animating = false;

    function tick() {
      currentX += (targetX - currentX) * 0.085;
      currentY += (targetY - currentY) * 0.085;
      var settled = Math.abs(targetX - currentX) < 0.1 && Math.abs(targetY - currentY) < 0.1;
      field.style.setProperty("--px", currentX.toFixed(2) + "px");
      field.style.setProperty("--py", currentY.toFixed(2) + "px");
      if (settled) {
        animating = false;
        return;
      }
      requestAnimationFrame(tick);
    }

    window.addEventListener(
      "pointermove",
      function (event) {
        // Off screen there is nothing to tilt, and writing the vars would
        // restyle the marks for no reason.
        if (hero && hero.classList.contains("is-offscreen")) return;
        targetX = (event.clientX / window.innerWidth - 0.5) * 26;
        targetY = (event.clientY / window.innerHeight - 0.5) * 18;
        if (!animating) {
          animating = true;
          requestAnimationFrame(tick);
        }
      },
      { passive: true },
    );

    reduce.addEventListener("change", function () {
      if (reduce.matches) {
        targetX = 0;
        targetY = 0;
        field.style.setProperty("--px", "0px");
        field.style.setProperty("--py", "0px");
      }
    });
  }

  /* ---------- provider-to-phone notification relay ---------- */
  var relay = document.querySelector("[data-relay]");
  if (relay) {
    var marks = Array.from(relay.querySelectorAll(".pmark"));
    var bird = relay.querySelector(".relay__bird");
    var notice = relay.querySelector(".relay__notice");
    var noticeIcon = relay.querySelector(".relay__notice-icon");
    var kind = relay.querySelector(".relay__notice-kicker");
    var source = relay.querySelector("[data-relay-source]");
    var message = relay.querySelector("[data-relay-message]");
    var busy = false;
    var next = 0;
    var modes = [
      ["permission", "Needs your approval"],
      ["question", "Which approach should I take?"],
      ["finished", "Task finished"],
      ["error", "Task failed"],
    ];

    function send(mark, automatic) {
      if (busy || (automatic && reduce.matches) || document.hidden || (hero && hero.classList.contains("is-offscreen"))) return;
      busy = true;
      var mode = modes[next++ % modes.length];
      kind.textContent = "Nudge · " + mode[0];
      source.textContent = mark.querySelector("img").alt;
      message.textContent = mode[1];
      mark.classList.add("is-sending");

      if (reduce.matches) {
        notice.classList.add("is-arrived");
        setTimeout(function () {
          mark.classList.remove("is-sending");
          notice.classList.remove("is-arrived");
          busy = false;
        }, 3600);
        return;
      }

      var wall = relay.getBoundingClientRect();
      var tile = mark.getBoundingClientRect();
      var target = noticeIcon.getBoundingClientRect();
      var startX = tile.left + tile.width / 2 - wall.left - 17;
      var startY = tile.top + tile.height / 2 - wall.top - 17;
      var dx = target.left + target.width / 2 - tile.left - tile.width / 2;
      var dy = target.top + target.height / 2 - tile.top - tile.height / 2;
      bird.style.left = startX + "px";
      bird.style.top = startY + "px";
      bird.animate(
        [
          { transform: "translate(0, 0) rotate(-15deg) scale(.6)", opacity: 0 },
          { transform: "translate(0, -12px) rotate(-12deg) scale(1)", opacity: 1, offset: 0.16 },
          { transform: "translate(" + dx * 0.55 + "px, " + (dy * 0.55 - 30) + "px) rotate(8deg)", opacity: 1, offset: 0.58 },
          { transform: "translate(" + dx + "px, " + dy + "px) rotate(12deg) scale(.65)", opacity: 0 },
        ],
        { duration: 1050, easing: "cubic-bezier(.4,0,.6,1)" },
      );

      setTimeout(function () {
        mark.classList.remove("is-sending");
        notice.classList.add("is-arrived");
      }, 780);
      setTimeout(function () {
        notice.classList.remove("is-arrived");
        busy = false;
      }, 3600);
    }

    marks.forEach(function (mark) {
      var card = mark.querySelector(".pmark__card");
      card.addEventListener("pointerenter", function () { send(mark); });
      card.addEventListener("focus", function () { send(mark); });
    });

    reduce.addEventListener("change", function () {
      if (reduce.matches) bird.getAnimations().forEach(function (animation) { animation.cancel(); });
    });

    function sendNext() {
      send(marks[next % marks.length], true);
      setTimeout(sendNext, 40000);
    }
    if (window.IntersectionObserver) {
      var started = false;
      new IntersectionObserver(function (entries) {
        if (started || !entries[0].isIntersecting) return;
        started = true;
        setTimeout(sendNext, 8000);
      }, { threshold: 0.35 }).observe(relay);
    } else {
      setTimeout(sendNext, 8000);
    }
  }

  /* ---------- idle the hero's infinite animations when it is off screen ---------- */
  if (hero && window.IntersectionObserver) {
    new IntersectionObserver(
      function (entries) {
        hero.classList.toggle("is-offscreen", !entries[0].isIntersecting);
      },
      { threshold: 0 },
    ).observe(hero);
  }
})();
