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
package org.netxms.nxmc;

import java.util.concurrent.atomic.AtomicBoolean;
import org.eclipse.rap.rwt.RWT;
import org.eclipse.rap.rwt.service.UISession;
import org.eclipse.swt.SWT;
import org.eclipse.swt.widgets.Display;
import org.eclipse.swt.widgets.Event;
import org.eclipse.swt.widgets.Listener;
import org.netxms.nxmc.base.windows.ResponsiveShellController;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * RWT entry point that installs the responsive main-shell controller after the
 * standard NXMC startup code has created the display and main window hierarchy.
 */
public class ResponsiveStartup extends Startup
{
   private static final Logger logger = LoggerFactory.getLogger(ResponsiveStartup.class);
   private static final int INSTALL_RETRY_DELAY = 250;
   // Fallback polling budget (2400 * 250ms = 10 minutes). The primary attach
   // path is event-driven (see registerShellListener); this loop only backstops
   // the case where the shell-open events are missed.
   private static final int INSTALL_RETRY_COUNT = 2400;
   private static final String LISTENER_KEY = "netxms.responsiveShellListener";

   @Override
   public int createUI()
   {
      UISession uiSession = RWT.getUISession();
      AtomicBoolean attached = new AtomicBoolean(false);

      Thread installer = new Thread(() -> {
         for(int i = 0; (i < INSTALL_RETRY_COUNT) && !attached.get(); i++)
         {
            try
            {
               Thread.sleep(INSTALL_RETRY_DELAY);
               uiSession.exec(() -> {
                  Display display = Display.getDefault();
                  if ((display != null) && !display.isDisposed())
                  {
                     display.asyncExec(() -> {
                        if (display.isDisposed() || attached.get())
                           return;
                        // Primary path: attach when the main shell is actually
                        // shown/activated, regardless of how long login takes.
                        registerShellListener(display, attached);
                        // Also try right now in case the main shell already exists.
                        tryAttach(display, attached);
                     });
                  }
               });
            }
            catch(InterruptedException e)
            {
               Thread.currentThread().interrupt();
               return;
            }
            catch(Exception e)
            {
               logger.debug("Unable to attach responsive shell controller yet", e);
            }
         }

         if (!attached.get())
            logger.warn("Responsive shell controller was not attached");
      }, "ResponsiveShellInstaller");
      installer.setDaemon(true);
      installer.start();

      return super.createUI();
   }

   /**
    * Register a one-time display-wide filter that attempts to attach the
    * responsive controller whenever a shell/widget is shown or activated. This
    * decouples attachment from wall-clock timing so a slow login (or an initial
    * release-notes dialog) can no longer cause the installer to miss the main
    * shell. The filter removes itself once the controller is attached.
    *
    * @param display current display
    * @param attached shared flag set once the controller is attached
    */
   private void registerShellListener(final Display display, final AtomicBoolean attached)
   {
      if (display.getData(LISTENER_KEY) != null)
         return;

      Listener listener = new Listener() {
         @Override
         public void handleEvent(Event event)
         {
            if (attached.get() || display.isDisposed())
               return;
            // Defer so the newly shown shell is fully populated before we walk it.
            display.asyncExec(() -> tryAttach(display, attached));
         }
      };
      display.addFilter(SWT.Show, listener);
      display.addFilter(SWT.Activate, listener);
      display.setData(LISTENER_KEY, listener);
   }

   /**
    * Attempt attachment once, and on success clear the display-wide filters so
    * they stop firing.
    *
    * @param display current display
    * @param attached shared flag set once the controller is attached
    */
   private void tryAttach(final Display display, final AtomicBoolean attached)
   {
      if (display.isDisposed() || attached.get())
         return;
      if (!ResponsiveShellController.attach(display))
         return;

      attached.set(true);
      Object stored = display.getData(LISTENER_KEY);
      if (stored instanceof Listener)
      {
         Listener listener = (Listener)stored;
         display.removeFilter(SWT.Show, listener);
         display.removeFilter(SWT.Activate, listener);
         display.setData(LISTENER_KEY, null);
      }
      logger.info("Responsive shell controller attached");
   }
}
