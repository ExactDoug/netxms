/**
 * mapinput.js
 *
 * RAP custom widget handler that routes continuous pointer input (touch pinch,
 * touch drag, mouse wheel, mouse drag) on a map canvas into the map's own pan
 * and zoom on the server side.
 *
 * RAP delivers no server-side SWT.MouseMove or SWT.MouseWheel by documented
 * intent, so a map canvas receives no continuous input stream at all. This
 * handler supplies one, using the same RemoteObject mechanism msgproxy.js uses
 * for mouseHover/mouseExit.
 *
 * It also owns gesture classification inside the map canvas, which makes it the
 * fix for three defects in the vendored longpress.js: that file has no
 * touches.length check (a pinch opens the context menu), no movement threshold
 * (a slow pan opens it), and it unhooks its own touchend listener after
 * duration * 4 ms, so a press held past ~2 s does nothing at all. Rather than
 * patch the vendored file, this handler classifies first and suppresses
 * longpress.js for any touch it has claimed - see touchEndCapture().
 *
 * License: MIT License - http://www.opensource.org/licenses/mit-license.php
 * Copyright (c) 2026 Raden Solutions
 */

(function() {
	'use strict';

	if (!window.netxms) {
		window.netxms = {};
	}

	/** Movement in px before a touch stops being a candidate tap/long press. */
	var MOVE_THRESHOLD = 10;

	/**
	 * Long press delay in ms. Deliberately has NO upper cutoff - the menu opens on this timer while
	 * the finger is still down, so holding longer never defeats it. The vendored longpress.js used
	 * 500 ms and fired on release; 500 ms proved too eager once the menu opened on press instead,
	 * and 1000 ms still read slightly quick on hardware.
	 *
	 * Any value above LONGPRESS_JS_THRESHOLD leaves a window in which longpress.js would otherwise
	 * open the menu first, so this constant cannot be raised without the touchEndCapture()
	 * suppression below being functional - see the startTime note there.
	 */
	var LONG_PRESS_DELAY = 1250;

	/**
	 * The threshold longpress.js uses (its own `duration`). It opens the context menu on release for
	 * any touch that lasted at least this long, and we cannot reach into its closure to stop it. So
	 * every touch at least this old must be suppressed here, not merely those our own long press
	 * timer has already claimed - otherwise longpress.js owns the whole window between its threshold
	 * and ours, and raising LONG_PRESS_DELAY only widens the window in which it wins.
	 */
	var LONGPRESS_JS_THRESHOLD = 500;

	/** Wheel notch to zoom factor. */
	var WHEEL_FACTOR = 0.0015;

	/** Clamp for a single coalesced zoom step, so one frame cannot jump wildly. */
	var MAX_STEP_IN = 4.0;
	var MAX_STEP_OUT = 0.25;

	rap.registerTypeHandler("netxms.MapInput", {

		factory : function(properties) {
			return new netxms.MapInput(properties);
		},

		destructor : "destroy",

		properties : [ ],

		events : [ "zoom", "pan" ]
	});

	/**
	 * Registry of live MapInput instances, keyed by the RWT id of the widget they serve.
	 *
	 * Listeners are installed ONCE on the document, at script load, rather than on each map's DOM
	 * node when its widget is created. Binding to the node was wrong in both directions: a gesture
	 * made before the binding arrived reached no listener at all and Safari took it as a whole page
	 * zoom, and a node replaced by a re-render left the listeners on a detached element. Ownership
	 * is therefore resolved per event, by walking up from the event target. While no map exists the
	 * registry is empty and these listeners do nothing anywhere in the UI.
	 */
	var instances = {};
	var listenersInstalled = false;

	/**
	 * Find the MapInput instance owning an event target, if any, and remember the widget node so
	 * that coordinates can be taken relative to it.
	 */
	var instanceCount = 0;

	var findOwner = function(target) {
		if (instanceCount === 0) {
			return null; // no map open anywhere - do not walk the tree on every pointer move
		}
		while (target != null && target !== document) {
			if (target.rwtWidget != null) {
				var owner = instances[target.rwtWidget._rwtId];
				if (owner) {
					owner.node = target;
					return owner;
				}
			}
			target = target.parentNode;
		}
		return null;
	};

	var installListeners = function() {
		if (listenersInstalled || !document.body) {
			return;
		}
		listenersInstalled = true;

		var dispatch = function(method) {
			return function(e) {
				var owner = findOwner(e.target);
				if (owner != null) {
					owner[method](e);
				}
			};
		};

		// Capture phase throughout, so these run before longpress.js's listener on the touch target
		// and before RAP's own handlers on document.body, which are registered in the bubble phase.
		document.addEventListener("touchstart", dispatch("touchStart"), { capture : true, passive : false });
		document.addEventListener("touchmove", dispatch("touchMove"), { capture : true, passive : false });
		document.addEventListener("touchend", dispatch("touchEndCapture"), { capture : true, passive : false });
		document.addEventListener("touchcancel", dispatch("touchEndCapture"), { capture : true, passive : false });
		document.addEventListener("wheel", dispatch("wheel"), { capture : true, passive : false });
		document.addEventListener("pointerdown", dispatch("pointerDown"), true);
		document.addEventListener("pointermove", dispatch("pointerMove"), true);
		document.addEventListener("pointerup", dispatch("pointerUp"), true);
		document.addEventListener("pointercancel", dispatch("pointerUp"), true);

		// Safari raises these alongside the touch stream for a pinch, and they are what actually
		// drive whole page zoom on iOS. Cancel them only over a map we own. Cancelling them
		// unconditionally is precisely the defect reported as eclipse-rap#398, so the ownership
		// test is not optional.
		var cancelGesture = function(e) {
			if (findOwner(e.target) != null) {
				e.preventDefault();
			}
		};
		document.addEventListener("gesturestart", cancelGesture, { capture : true, passive : false });
		document.addEventListener("gesturechange", cancelGesture, { capture : true, passive : false });
		document.addEventListener("gestureend", cancelGesture, { capture : true, passive : false });
	};

	if (document.body) {
		installListeners();
	} else {
		document.addEventListener("DOMContentLoaded", installListeners);
	}

	netxms.MapInput = function(properties) {
		this.parentId = properties.parent;
		this.node = null;
		if (!instances[this.parentId]) {
			instanceCount++;
		}
		instances[this.parentId] = this;
		installListeners();

		// Coalescing state - everything is accumulated here and flushed once per
		// animation frame. The coalescing MUST happen in the browser: each notify
		// is a full client/server round trip, and every zoom change triggers a
		// full viewer refresh on the server side.
		this.frame = null;
		this.zoomFactor = 1.0;
		this.zoomX = 0;
		this.zoomY = 0;
		this.zoomPending = false;
		this.panX = 0;
		this.panY = 0;
		this.panPending = false;

		this.resetGesture();
	};

	netxms.MapInput.prototype = {

		/**
		 * True if the event started on the map drawing surface rather than on a
		 * scrollbar or another child widget. Scrollbar dragging already works and
		 * must not be claimed.
		 */
		onCanvas : function(target) {
			while (target != null && target !== this.node) {
				if (target.tagName === "CANVAS") {
					return true;
				}
				target = target.parentNode;
			}
			return false;
		},

		resetGesture : function() {
			this.tracking = false;
			this.pinching = false;
			this.moved = false;
			this.consumed = false;
			this.startX = 0;
			this.startY = 0;
			this.lastX = 0;
			this.lastY = 0;
			this.lastDistance = 0;
			this.startTime = 0;
			this.cancelLongPress();
		},

		cancelLongPress : function() {
			if (this.longPressTimer) {
				clearTimeout(this.longPressTimer);
				this.longPressTimer = null;
			}
		},

		touchStart : function(e) {
			if (e.touches.length > 1) {
				// Second finger down - this is a pinch, never a press.
				this.cancelLongPress();
				if (!this.tracking) {
					// Both fingers landed together closely enough that the first touchstart we
					// saw already carried two touches, so there was never a single touch event
					// to begin tracking on. Without this the gesture goes unclaimed and Safari
					// takes it as a page zoom.
					if (!this.onCanvas(e.target) && !this.onCanvas(e.touches[0].target)) {
						return;
					}
					this.resetGesture();
					this.tracking = true;
					this.startTime = new Date().getTime();
				}
				this.pinching = true;
				this.consumed = true;
				this.lastDistance = this.distance(e.touches);
				var mid = this.midpoint(e.touches);
				this.lastX = mid.x;
				this.lastY = mid.y;
				return;
			}

			if (!this.onCanvas(e.target)) {
				return;
			}

			this.resetGesture();
			this.tracking = true;
			this.startTime = new Date().getTime();
			var t = e.touches[0];
			this.startX = this.lastX = t.clientX;
			this.startY = this.lastY = t.clientY;

			// Our own long press: single touch, below the movement threshold, and
			// with no upper time limit.
			var self = this;
			var target = e.target;
			var x = t.pageX;
			var y = t.pageY;
			this.longPressTimer = setTimeout(function() {
				self.longPressTimer = null;
				if (self.tracking && !self.moved && !self.pinching) {
					self.consumed = true;
					self.openContextMenu(target, x, y);
				}
			}, LONG_PRESS_DELAY);
		},

		touchMove : function(e) {
			if (!this.tracking) {
				return;
			}

			if (e.touches.length > 1) {
				this.cancelLongPress();
				this.pinching = true;
				this.moved = true;
				this.consumed = true;
				var distance = this.distance(e.touches);
				var mid = this.midpoint(e.touches);
				if (this.lastDistance > 0 && distance > 0) {
					this.queueZoom(distance / this.lastDistance, mid.x, mid.y);
					// A pinch that also translates should pan.
					this.queuePan(mid.x - this.lastX, mid.y - this.lastY);
				}
				this.lastDistance = distance;
				this.lastX = mid.x;
				this.lastY = mid.y;
				e.preventDefault();
				return;
			}

			var t = e.touches[0];
			if (!this.moved) {
				if (Math.abs(t.clientX - this.startX) < MOVE_THRESHOLD && Math.abs(t.clientY - this.startY) < MOVE_THRESHOLD) {
					return;
				}
				this.moved = true;
				this.consumed = true;
				this.cancelLongPress();
			}

			this.queuePan(t.clientX - this.lastX, t.clientY - this.lastY);
			this.lastX = t.clientX;
			this.lastY = t.clientY;
			e.preventDefault();
		},

		/**
		 * Capture-phase end of touch. If this touch was claimed as a pan, a pinch or a long press we
		 * already handled, stop it here so that longpress.js - which listens on the touch target, and
		 * so would otherwise run first - cannot also act on it.
		 *
		 * The `held` arm is what covers the window between longpress.js's own threshold and ours, in
		 * which the touch is too old for longpress.js to ignore but too young for our timer to have
		 * claimed it. It depends on startTime being stamped in touchStart: without that stamp `held`
		 * is always 0, this arm is dead, and longpress.js owns that entire window.
		 *
		 * A quick tap is below the threshold and is never suppressed, so ordinary tap-to-select and
		 * RAP's click synthesis are untouched. A deliberately SLOW tap is suppressed, and losing its
		 * selection is the known cost of closing the window.
		 */
		touchEndCapture : function(e) {
			var held = (this.startTime > 0) ? (new Date().getTime() - this.startTime) : 0;
			if (this.consumed || held >= LONGPRESS_JS_THRESHOLD) {
				e.stopPropagation();
			}
			if (e.touches && e.touches.length > 0) {
				return;
			}
			this.flush();
			this.resetGesture();
		},

		openContextMenu : function(target, x, y) {
			setTimeout(function() {
				try {
					var object = rwt.event.EventHandlerUtil.getTargetObject(target);
					var control = rwt.widgets.util.WidgetUtil.getControl(object);
					var contextMenu = control ? control.getContextMenu() : null;
					if (contextMenu != null) {
						contextMenu.setLocation(x, y);
						contextMenu.setOpener(control);
						contextMenu.show();
					}
				} catch (err) {
					console.log(err);
				}
			}, 50);
		},

		wheel : function(e) {
			if (!this.onCanvas(e.target)) {
				return;
			}
			var rect = this.node.getBoundingClientRect();
			this.queueZoom(Math.exp(-e.deltaY * WHEEL_FACTOR), e.clientX - rect.left, e.clientY - rect.top);
			e.preventDefault();
		},

		pointerDown : function(e) {
			if (e.pointerType === "touch" || e.button !== 0 || !this.onCanvas(e.target)) {
				return;
			}
			this.mousePanning = true;
			this.mouseMoved = false;
			this.lastMouseX = e.clientX;
			this.lastMouseY = e.clientY;
		},

		pointerMove : function(e) {
			if (!this.mousePanning || e.buttons !== 1) {
				return;
			}
			var dx = e.clientX - this.lastMouseX;
			var dy = e.clientY - this.lastMouseY;
			if (!this.mouseMoved && Math.abs(dx) < MOVE_THRESHOLD && Math.abs(dy) < MOVE_THRESHOLD) {
				return;
			}
			this.mouseMoved = true;
			this.queuePan(dx, dy);
			this.lastMouseX = e.clientX;
			this.lastMouseY = e.clientY;
		},

		pointerUp : function(e) {
			if (this.mousePanning) {
				this.mousePanning = false;
				this.flush();
			}
		},

		distance : function(touches) {
			var dx = touches[0].clientX - touches[1].clientX;
			var dy = touches[0].clientY - touches[1].clientY;
			return Math.sqrt(dx * dx + dy * dy);
		},

		midpoint : function(touches) {
			return {
				x : (touches[0].clientX + touches[1].clientX) / 2,
				y : (touches[0].clientY + touches[1].clientY) / 2
			};
		},

		queueZoom : function(factor, x, y) {
			if (!isFinite(factor) || factor <= 0) {
				return;
			}
			var rect = this.node.getBoundingClientRect();
			this.zoomFactor = this.zoomFactor * factor;
			this.zoomX = Math.round(x - rect.left);
			this.zoomY = Math.round(y - rect.top);
			this.zoomPending = true;
			this.schedule();
		},

		queuePan : function(dx, dy) {
			if (dx === 0 && dy === 0) {
				return;
			}
			this.panX += dx;
			this.panY += dy;
			this.panPending = true;
			this.schedule();
		},

		schedule : function() {
			if (this.frame !== null) {
				return;
			}
			var self = this;
			this.frame = window.requestAnimationFrame(function() {
				self.frame = null;
				self.flush();
			});
		},

		/**
		 * Send at most one zoom and one pan notification per animation frame.
		 */
		flush : function() {
			if (this.frame !== null) {
				window.cancelAnimationFrame(this.frame);
				this.frame = null;
			}

			var remote = rap.getRemoteObject(this);

			if (this.zoomPending) {
				var factor = Math.min(MAX_STEP_IN, Math.max(MAX_STEP_OUT, this.zoomFactor));
				remote.notify("zoom", {
					factor : factor,
					x : this.zoomX,
					y : this.zoomY
				});
				this.zoomFactor = 1.0;
				this.zoomPending = false;
			}

			if (this.panPending) {
				remote.notify("pan", {
					dx : Math.round(this.panX),
					dy : Math.round(this.panY)
				});
				this.panX = 0;
				this.panY = 0;
				this.panPending = false;
			}
		},

		destroy : function() {
			this.cancelLongPress();
			if (this.frame !== null) {
				window.cancelAnimationFrame(this.frame);
				this.frame = null;
			}
			// The document listeners are shared and stay installed; dropping out of the registry is
			// what stops events being routed here.
			if (instances[this.parentId] === this) {
				delete instances[this.parentId];
				instanceCount--;
			}
			this.node = null;
		}
	};
}());
