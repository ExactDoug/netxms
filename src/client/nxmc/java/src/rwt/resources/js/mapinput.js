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
 * longpress.js for any touch it has claimed - see suppressLongPress().
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

	/** Long press delay in ms. Deliberately has NO upper cutoff. */
	var LONG_PRESS_DELAY = 500;

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

	netxms.MapInput = function(properties) {
		this.parentId = properties.parent;
		this.node = null;

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

		var self = this;
		this.renderHandler = function() {
			self.attach();
		};
		rap.on("render", this.renderHandler);
		this.attach();
	};

	netxms.MapInput.prototype = {

		/**
		 * Locate the DOM node of the parent widget and attach listeners to it.
		 *
		 * The node is found by the same scan rwt-util.js uses (rwtWidget._rwtId),
		 * which was confirmed on hardware to resolve the map widget div that the
		 * map's <canvas> lives inside. It may not exist yet when this object is
		 * created, so this is retried on every render until it succeeds.
		 */
		attach : function() {
			if (this.node !== null) {
				return;
			}

			var node = null;
			var elements = document.getElementsByTagName("div");
			for(var i = 0; i < elements.length; i++) {
				if (elements[i].rwtWidget != null && elements[i].rwtWidget._rwtId == this.parentId) {
					node = elements[i];
					break;
				}
			}
			if (node === null) {
				return;
			}

			this.node = node;
			rap.off("render", this.renderHandler);

			var self = this;
			this.onTouchStart = function(e) { self.touchStart(e); };
			this.onTouchMove = function(e) { self.touchMove(e); };
			this.onTouchEnd = function(e) { self.touchEnd(e); };
			this.onTouchEndCapture = function(e) { self.suppressLongPress(e); };
			this.onWheel = function(e) { self.wheel(e); };
			this.onPointerDown = function(e) { self.pointerDown(e); };
			this.onPointerMove = function(e) { self.pointerMove(e); };
			this.onPointerUp = function(e) { self.pointerUp(e); };

			// Capture phase, so this runs before longpress.js's listener on the
			// canvas itself (target phase) and before RAP's on document.body
			// (bubble phase).
			node.addEventListener("touchend", this.onTouchEndCapture, true);
			node.addEventListener("touchcancel", this.onTouchEndCapture, true);

			node.addEventListener("touchstart", this.onTouchStart, { passive : false });
			node.addEventListener("touchmove", this.onTouchMove, { passive : false });
			node.addEventListener("touchend", this.onTouchEnd, { passive : false });
			node.addEventListener("touchcancel", this.onTouchEnd, { passive : false });
			node.addEventListener("wheel", this.onWheel, { passive : false });
			node.addEventListener("pointerdown", this.onPointerDown, false);
			node.addEventListener("pointermove", this.onPointerMove, false);
			node.addEventListener("pointerup", this.onPointerUp, false);
			node.addEventListener("pointercancel", this.onPointerUp, false);
		},

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
				if (this.tracking) {
					this.pinching = true;
					this.consumed = true;
					this.lastDistance = this.distance(e.touches);
					var mid = this.midpoint(e.touches);
					this.lastX = mid.x;
					this.lastY = mid.y;
				}
				return;
			}

			if (!this.onCanvas(e.target)) {
				return;
			}

			this.resetGesture();
			this.tracking = true;
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

		touchEnd : function(e) {
			if (e.touches && e.touches.length > 0) {
				return;
			}
			this.flush();
			this.resetGesture();
		},

		/**
		 * Capture-phase handler. If this touch was claimed as a pan, a pinch or a
		 * long press we already handled, stop it here so that longpress.js (which
		 * listens on the touch target) cannot also act on it. A plain tap is never
		 * suppressed, so tap-to-select and RAP's click synthesis are untouched.
		 */
		suppressLongPress : function(e) {
			if (this.consumed) {
				e.stopPropagation();
			}
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
			rap.off("render", this.renderHandler);
			if (this.node !== null) {
				this.node.removeEventListener("touchend", this.onTouchEndCapture, true);
				this.node.removeEventListener("touchcancel", this.onTouchEndCapture, true);
				this.node.removeEventListener("touchstart", this.onTouchStart);
				this.node.removeEventListener("touchmove", this.onTouchMove);
				this.node.removeEventListener("touchend", this.onTouchEnd);
				this.node.removeEventListener("touchcancel", this.onTouchEnd);
				this.node.removeEventListener("wheel", this.onWheel);
				this.node.removeEventListener("pointerdown", this.onPointerDown);
				this.node.removeEventListener("pointermove", this.onPointerMove);
				this.node.removeEventListener("pointerup", this.onPointerUp);
				this.node.removeEventListener("pointercancel", this.onPointerUp);
				this.node = null;
			}
		}
	};
}());
