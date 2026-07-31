/**
 * NetXMS - open source network management system
 * Copyright (C) 2003-2026 Raden Solutions
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 675 Mass Ave, Cambridge, MA 02139, USA.
 */
package org.netxms.nxmc.tools;

/**
 * Listener for continuous pointer input (pinch, drag, wheel) on a map canvas.
 *
 * On the desktop client SWT delivers mouse move and mouse wheel events directly, so this listener is not used. In the web client RAP
 * delivers neither by documented intent, and the input stream is supplied by a client side custom widget instead.
 */
public interface MapInputListener
{
   /**
    * Zoom by a relative factor around a focal point.
    *
    * @param factor relative zoom factor (greater than 1 zooms in)
    * @param x focal point X, in pixels relative to the top left of the canvas
    * @param y focal point Y, in pixels relative to the top left of the canvas
    */
   public void onZoom(double factor, int x, int y);

   /**
    * Pan by a delta expressed as pointer movement. Moving the pointer right moves the map content right, so the view location moves
    * in the opposite direction.
    *
    * @param dx pointer movement along X, in pixels
    * @param dy pointer movement along Y, in pixels
    */
   public void onPan(int dx, int dy);
}
