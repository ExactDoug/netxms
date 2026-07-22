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
import org.eclipse.swt.widgets.Display;
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
   private static final int INSTALL_RETRY_COUNT = 240;

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
                        if (!display.isDisposed())
                           attached.set(ResponsiveShellController.attach(display));
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
}
