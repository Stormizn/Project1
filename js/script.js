// Linkzyfy — shared UI motion (no database code here)
//
// Everything here is exposed on `window.linkzyfyUI` as well, because a
// lot of Linkzyfy's markup is built by JavaScript AFTER this file runs.
//
// The bug this guards against: CSS sets `.js [data-reveal] { opacity: 0 }`
// so that content fades in on scroll. If a card is created later (a
// dashboard recommendation, a connection row, a discover result) it
// inherits `opacity: 0`, but nothing ever adds `.is-in` to it — the
// observer only ever saw the nodes that existed at page load. The card
// stayed invisible forever.
//
// `enhance()` walks newly-inserted subtrees and wires them up, and a
// MutationObserver on <body> calls it automatically, so render code
// does not have to remember to do anything.
(function () {
    var root = document.documentElement;
    root.classList.add("js");

    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

    var revealed = new WeakSet();
    var tilted = new WeakSet();

    // Null when we should not animate at all (reduced motion, or no
    // IntersectionObserver support) — every node is shown immediately.
    var io = null;
    var ioFired = false;

    // ---- Scroll reveal -------------------------------------------------

    function showNow(el) {
        el.classList.add("is-in");
        if (io) io.unobserve(el);
    }

    // Stagger siblings that were marked for reveal in the same pass, so a
    // grid cascades instead of popping in all at once.
    function applyStagger(el) {
        var parent = el.parentElement;
        if (!parent) return;

        var sibs = Array.prototype.filter.call(parent.children, function (c) {
            return c.hasAttribute("data-reveal");
        });

        var i = sibs.indexOf(el);
        if (i > 0) el.style.setProperty("--d", Math.min(i, 6));
    }

    function revealNode(el) {
        if (!el || revealed.has(el)) return;
        revealed.add(el);

        applyStagger(el);

        if (!io) {
            showNow(el);
            return;
        }

        // Already on screen? Don't make the user wait for the observer.
        if (el.getBoundingClientRect().top < window.innerHeight) {
            showNow(el);
            return;
        }

        io.observe(el);
    }

    function showAllIn(list) {
        list.forEach(function (el) {
            revealed.add(el);
            showNow(el);
        });
    }

    if (!reduce && "IntersectionObserver" in window && document.visibilityState !== "hidden") {
        io = new IntersectionObserver(function (entries) {
            ioFired = true;
            entries.forEach(function (entry) {
                if (entry.isIntersecting) showNow(entry.target);
            });
        }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });

        // Safety net: if the observer never runs (embedded/background
        // views, headless screenshotting) show everything anyway.
        setTimeout(function () {
            if (!ioFired) {
                showAllIn(document.querySelectorAll("[data-reveal]"));
            }
        }, 1800);
    }

    function collectReveals(scope) {
        var nodes = [];

        if (scope.nodeType === 1 && scope.hasAttribute("data-reveal")) {
            nodes.push(scope);
        }

        if (scope.querySelectorAll) {
            nodes = nodes.concat(
                Array.prototype.slice.call(scope.querySelectorAll("[data-reveal]"))
            );
        }

        return nodes;
    }

    // ---- Pointer tilt --------------------------------------------------

    function tiltNode(el) {
        if (!el || tilted.has(el)) return;
        tilted.add(el);

        var max = parseFloat(el.getAttribute("data-tilt")) || 5;

        el.addEventListener("pointermove", function (e) {
            var r = el.getBoundingClientRect();
            var x = (e.clientX - r.left) / r.width - 0.5;
            var y = (e.clientY - r.top) / r.height - 0.5;
            el.style.setProperty("--rx", (-y * max).toFixed(2) + "deg");
            el.style.setProperty("--ry", (x * max * 1.2).toFixed(2) + "deg");
        });

        el.addEventListener("pointerleave", function () {
            el.style.setProperty("--rx", "0deg");
            el.style.setProperty("--ry", "0deg");
        });
    }

    // ---- Public entry point --------------------------------------------

    // Wire up every [data-reveal] / [data-tilt] inside `scope`.
    // Safe to call repeatedly and on any subtree.
    function enhance(scope) {
        var target = scope || document;

        collectReveals(target).forEach(revealNode);

        if (reduce || !finePointer) return;

        var tiltNodes = [];
        if (target.nodeType === 1 && target.hasAttribute("data-tilt")) {
            tiltNodes.push(target);
        }
        if (target.querySelectorAll) {
            tiltNodes = tiltNodes.concat(
                Array.prototype.slice.call(target.querySelectorAll("[data-tilt]"))
            );
        }
        tiltNodes.forEach(tiltNode);
    }

    window.linkzyfyUI = {
        enhance: enhance,
        reveal: revealNode,
        showAll: function () {
            showAllIn(document.querySelectorAll("[data-reveal]"));
        }
    };

    // ---- Boot ----------------------------------------------------------

    enhance(document);

    // Catch anything rendered later. `subtree` + childList is enough:
    // attributes are irrelevant because we key off [data-reveal] and
    // [data-tilt] at insertion time, and the WeakSets stop double-binding.
    if (window.MutationObserver && document.body) {
        var pending = null;
        var flush = function () {
            pending = null;
            enhance(document.body);
        };

        new MutationObserver(function (mutations) {
            var worthIt = mutations.some(function (m) {
                return m.addedNodes && m.addedNodes.length > 0;
            });
            if (!worthIt || pending) return;
            // Batch to one pass per frame — render code often appends a
            // whole list in a loop.
            pending = window.requestAnimationFrame
                ? window.requestAnimationFrame(flush)
                : window.setTimeout(flush, 0);
        }).observe(document.body, { childList: true, subtree: true });
    }

    window.addEventListener("beforeprint", function () {
        window.linkzyfyUI.showAll();
    });

    // ---- Header hairline once scrolled ---------------------------------

    var header = document.querySelector(".site-header");
    if (header) {
        var onScroll = function () { header.classList.toggle("is-scrolled", window.scrollY > 8); };
        onScroll();
        window.addEventListener("scroll", onScroll, { passive: true });
    }

    // ---- Scroll parallax on 3D stacks (--p from -1 to 1) ----------------

    function refreshParallax() {
        var stacks = document.querySelectorAll("[data-parallax]");
        if (!stacks.length || reduce) return;

        var ticking = false;
        var update = function () {
            stacks.forEach(function (el) {
                var r = el.getBoundingClientRect();
                var p = (r.top + r.height / 2 - window.innerHeight / 2) / window.innerHeight;
                el.style.setProperty("--p", Math.max(-1, Math.min(1, p)).toFixed(3));
            });
            ticking = false;
        };

        if (window._linkzyfyParallaxCleanup) window._linkzyfyParallaxCleanup();

        var onScroll = function () {
            if (!ticking) { ticking = true; window.requestAnimationFrame(update); }
        };

        window.addEventListener("scroll", onScroll, { passive: true });
        update();

        window._linkzyfyParallaxCleanup = function () {
            window.removeEventListener("scroll", onScroll);
        };
    }

    refreshParallax();

    // ---- Dateline ------------------------------------------------------

    function refreshDateline() {
        document.querySelectorAll("[data-today]").forEach(function (el) {
            el.textContent = new Date().toLocaleDateString(undefined, {
                weekday: "long", day: "numeric", month: "long"
            });
        });
    }

    refreshDateline();
})();
