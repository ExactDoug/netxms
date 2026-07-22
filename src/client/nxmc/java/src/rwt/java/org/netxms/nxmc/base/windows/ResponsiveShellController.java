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
package org.netxms.nxmc.base.windows;

import java.util.IdentityHashMap;
import java.util.Map;
import org.eclipse.rap.rwt.RWT;
import org.eclipse.rap.rwt.service.UISession;
import org.eclipse.swt.SWT;
import org.eclipse.swt.custom.SashForm;
import org.eclipse.swt.events.ControlAdapter;
import org.eclipse.swt.events.ControlEvent;
import org.eclipse.swt.graphics.Point;
import org.eclipse.swt.layout.GridData;
import org.eclipse.swt.widgets.Composite;
import org.eclipse.swt.widgets.Control;
import org.eclipse.swt.widgets.Display;
import org.eclipse.swt.widgets.Label;
import org.eclipse.swt.widgets.Shell;
import org.netxms.nxmc.PreferenceStore;
import org.netxms.nxmc.base.widgets.PerspectiveSwitcher;
import org.netxms.nxmc.base.widgets.RoundedLabel;
import org.netxms.nxmc.base.widgets.ServerClock;
import org.netxms.nxmc.base.widgets.Spacer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Responsive presentation controller for the RWT management console shell.
 *
 * The controller works with the existing widget tree instead of recreating
 * views. This preserves perspective state, open tabs, selections, and pinned
 * views while changing their presentation according to the available browser
 * width.
 */
public final class ResponsiveShellController
{
   private static final String CONTROLLER_ATTRIBUTE = ResponsiveShellController.class.getName() + ".controller";

   private ResponsiveShellController()
   {
   }

   /**
    * Attach the responsive controller to the fully constructed NXMC main shell.
    * This method must be called from the UI thread. It is safe to call repeatedly.
    *
    * @param display current RWT display
    * @return true if the main shell was found and the controller is attached
    */
   public static boolean attach(Display display)
   {
      if ((display == null) || display.isDisposed())
         return false;

      UISession session = RWT.getUISession();
      Controller controller = (Controller)session.getAttribute(CONTROLLER_ATTRIBUTE);
      if ((controller == null) || controller.isDisposed())
      {
         controller = Controller.attach(display);
         if (controller == null)
            return false;
         session.setAttribute(CONTROLLER_ATTRIBUTE, controller);
      }
      else
      {
         controller.refresh();
      }
      return true;
   }

   /**
    * Per-UI-session responsive shell controller.
    */
   private static final class Controller
   {
      private static final Logger logger = LoggerFactory.getLogger(Controller.class);

      private static final int NARROW_MAX_WIDTH = 699;
      private static final int COMPACT_MAX_WIDTH = 1199;
      private static final int RESIZE_DELAY = 125;
      private static final int EXPANDED_SWITCHER_THRESHOLD = 100;
      private static final String SWITCHER_PREFERENCE = "PerspectiveSwitcher.Expanded";

      private final Display display;
      private final Shell shell;
      private final PerspectiveSwitcher perspectiveSwitcher;
      private final Map<Control, Object> originalHeaderLayoutData = new IdentityHashMap<>();
      private final Map<Control, Boolean> originalVisibility = new IdentityHashMap<>();
      private final Map<SashForm, int[]> expandedSashWeights = new IdentityHashMap<>();

      private Composite windowContent;
      private Composite headerArea;
      private Composite mainAreaInner;
      private SashForm horizontalSplitArea;
      private SashForm verticalSplitArea;
      private Control perspectiveArea;
      private ShellMode mode = null;
      private boolean wideSwitcherExpanded;
      private boolean resizeScheduled = false;

      private final Runnable resizeTask = new Runnable() {
         @Override
         public void run()
         {
            resizeScheduled = false;
            refresh();
         }
      };

      private Controller(Display display, Shell shell, PerspectiveSwitcher perspectiveSwitcher)
      {
         this.display = display;
         this.shell = shell;
         this.perspectiveSwitcher = perspectiveSwitcher;
         wideSwitcherExpanded = isPerspectiveSwitcherExpanded();

         shell.addControlListener(new ControlAdapter() {
            @Override
            public void controlResized(ControlEvent e)
            {
               scheduleRefresh();
            }
         });

         shell.addDisposeListener((e) -> {
            if (!display.isDisposed())
               display.timerExec(-1, resizeTask);
         });
      }

      /**
       * Find the fully constructed NXMC main shell and attach a controller.
       * Login and auxiliary shells are ignored because they do not contain a
       * PerspectiveSwitcher.
       */
      static Controller attach(Display display)
      {
         for(Shell shell : display.getShells())
         {
            if (shell.isDisposed())
               continue;

            PerspectiveSwitcher switcher = findDescendant(shell, PerspectiveSwitcher.class);
            if (switcher != null)
            {
               Controller controller = new Controller(display, shell, switcher);
               controller.refresh();
               return controller;
            }
         }
         return null;
      }

      boolean isDisposed()
      {
         return shell.isDisposed() || perspectiveSwitcher.isDisposed();
      }

      void refresh()
      {
         if (isDisposed())
            return;

         resolveStructure();
         if ((windowContent == null) || (headerArea == null) || (mainAreaInner == null))
            return;

         int width = windowContent.getClientArea().width;
         if (width <= 0)
            width = shell.getClientArea().width;
         if (width <= 0)
            return;

         ShellMode newMode = getMode(width);
         if (mode == ShellMode.WIDE)
            wideSwitcherExpanded = isPerspectiveSwitcherExpanded();

         boolean modeChanged = mode != newMode;
         mode = newMode;
         applyMode(modeChanged);
      }

      private void scheduleRefresh()
      {
         if (isDisposed())
            return;

         if (resizeScheduled)
            display.timerExec(-1, resizeTask);
         resizeScheduled = true;
         display.timerExec(RESIZE_DELAY, resizeTask);
      }

      /**
       * Resolve the shell structure from the public widget hierarchy. This is
       * repeated because optional pin areas and the AI chat panel are dynamic.
       */
      private void resolveStructure()
      {
         mainAreaInner = perspectiveSwitcher.getParent();
         Composite mainArea = mainAreaInner.getParent();
         windowContent = mainArea.getParent();

         headerArea = null;
         for(Control child : windowContent.getChildren())
         {
            if ((child != mainArea) && (child instanceof Composite))
            {
               headerArea = (Composite)child;
               break;
            }
         }

         horizontalSplitArea = findDirectChild(mainAreaInner, SashForm.class);
         verticalSplitArea = (horizontalSplitArea != null) ? findDirectChild(horizontalSplitArea, SashForm.class) : null;
         perspectiveArea = null;
         if (verticalSplitArea != null)
         {
            Control[] children = verticalSplitArea.getChildren();
            if (children.length > 0)
               perspectiveArea = children[0];
         }
      }

      private static ShellMode getMode(int width)
      {
         if (width <= NARROW_MAX_WIDTH)
            return ShellMode.NARROW;
         if (width <= COMPACT_MAX_WIDTH)
            return ShellMode.COMPACT;
         return ShellMode.WIDE;
      }

      private void applyMode(boolean modeChanged)
      {
         if (modeChanged)
            logger.debug("RWT shell presentation changed to {} mode", mode);

         updateHeader(mode != ShellMode.WIDE);

         if (mode == ShellMode.WIDE)
         {
            setPerspectiveSwitcherExpanded(wideSwitcherExpanded);
            restoreSash(horizontalSplitArea, verticalSplitArea);
            restoreSash(verticalSplitArea, perspectiveArea);
         }
         else
         {
            // Keep a compact icon rail at tablet and phone widths. It remains
            // usable while consuming only 48 pixels and avoids destroying or
            // recreating perspective controls.
            setPerspectiveSwitcherExpanded(false);
            collapseSash(horizontalSplitArea, verticalSplitArea);
            if (mode == ShellMode.NARROW)
               collapseSash(verticalSplitArea, perspectiveArea);
            else
               restoreSash(verticalSplitArea, perspectiveArea);
         }

         headerArea.layout(true, true);
         mainAreaInner.layout(true, true);
         windowContent.layout(true, true);
      }

      /**
       * Remove nonessential text and spacing from the fixed desktop header at
       * compact widths. Action buttons and the synchronization warning remain
       * available at every width.
       */
      private void updateHeader(boolean compact)
      {
         for(Control control : headerArea.getChildren())
         {
            if (!control.isDisposed())
               setHeaderControlExcluded(control, compact && isOptionalHeaderControl(control));
         }
      }

      private static boolean isOptionalHeaderControl(Control control)
      {
         if (control instanceof Spacer)
            return true;

         if (control instanceof RoundedLabel)
         {
            // The server-name label has a tooltip; the objects-out-of-sync
            // indicator intentionally does not and must remain visible.
            return control.getToolTipText() != null;
         }

         if ((control instanceof Composite) && containsDescendant((Composite)control, ServerClock.class))
            return true;

         if (control instanceof Label)
         {
            Label label = (Label)control;
            Object variant = label.getData(RWT.CUSTOM_VARIANT);
            if ("MainWindowHeaderBold".equals(variant))
               return true;

            String text = label.getText();
            return (text != null) && text.contains("@");
         }
         return false;
      }

      private void setHeaderControlExcluded(Control control, boolean excluded)
      {
         if (excluded)
         {
            if (!originalHeaderLayoutData.containsKey(control))
               originalHeaderLayoutData.put(control, control.getLayoutData());

            GridData layoutData = copyGridData(control.getLayoutData());
            layoutData.exclude = true;
            control.setLayoutData(layoutData);
            control.setVisible(false);
         }
         else if (originalHeaderLayoutData.containsKey(control))
         {
            control.setLayoutData(originalHeaderLayoutData.remove(control));
            control.setVisible(true);
         }
      }

      private boolean isPerspectiveSwitcherExpanded()
      {
         Point size = perspectiveSwitcher.computeSize(SWT.DEFAULT, SWT.DEFAULT, false);
         return size.x >= EXPANDED_SWITCHER_THRESHOLD;
      }

      private void setPerspectiveSwitcherExpanded(boolean expanded)
      {
         if (isPerspectiveSwitcherExpanded() == expanded)
            return;

         // toggle() normally persists the temporary responsive state. Preserve
         // the user's actual preference while changing only this UI session.
         PreferenceStore preferenceStore = PreferenceStore.getInstance();
         boolean persistedValue = preferenceStore.getAsBoolean(SWITCHER_PREFERENCE, true);
         perspectiveSwitcher.toggle();
         preferenceStore.set(SWITCHER_PREFERENCE, persistedValue);
      }

      private void collapseSash(SashForm sash, Control keep)
      {
         if ((sash == null) || sash.isDisposed() || (keep == null) || keep.isDisposed())
            return;

         Control[] children = sash.getChildren();
         if (children.length <= 1)
            return;

         int[] currentWeights = sash.getWeights();
         if (!expandedSashWeights.containsKey(sash) && (currentWeights.length == children.length))
            expandedSashWeights.put(sash, currentWeights.clone());

         int[] collapsedWeights = new int[children.length];
         for(int i = 0; i < children.length; i++)
         {
            Control child = children[i];
            if (child == keep)
            {
               collapsedWeights[i] = 1000;
               child.setVisible(true);
            }
            else
            {
               collapsedWeights[i] = 1;
               if (!originalVisibility.containsKey(child))
                  originalVisibility.put(child, child.getVisible());
               child.setVisible(false);
            }
         }
         sash.setWeights(collapsedWeights);
      }

      private void restoreSash(SashForm sash, Control keep)
      {
         if ((sash == null) || sash.isDisposed() || (keep == null) || keep.isDisposed())
            return;

         Control[] children = sash.getChildren();
         if (children.length == 0)
            return;

         for(Control child : children)
         {
            if (child == keep)
            {
               child.setVisible(true);
            }
            else
            {
               Boolean visible = originalVisibility.remove(child);
               if (visible != null)
                  child.setVisible(visible);
            }
         }

         int[] weights = expandedSashWeights.remove(sash);
         if ((weights != null) && (weights.length == children.length))
            sash.setWeights(weights);
         else if (weights != null)
            sash.setWeights(createDefaultWeights(children, keep));
      }

      private static int[] createDefaultWeights(Control[] children, Control keep)
      {
         int[] weights = new int[children.length];
         if (children.length == 1)
         {
            weights[0] = 1000;
            return weights;
         }

         int secondaryWeight = 300 / (children.length - 1);
         for(int i = 0; i < children.length; i++)
            weights[i] = (children[i] == keep) ? 700 : secondaryWeight;
         return weights;
      }

      private static GridData copyGridData(Object source)
      {
         GridData copy = new GridData();
         if (!(source instanceof GridData))
            return copy;

         GridData original = (GridData)source;
         copy.verticalAlignment = original.verticalAlignment;
         copy.horizontalAlignment = original.horizontalAlignment;
         copy.widthHint = original.widthHint;
         copy.heightHint = original.heightHint;
         copy.horizontalIndent = original.horizontalIndent;
         copy.verticalIndent = original.verticalIndent;
         copy.horizontalSpan = original.horizontalSpan;
         copy.verticalSpan = original.verticalSpan;
         copy.grabExcessHorizontalSpace = original.grabExcessHorizontalSpace;
         copy.grabExcessVerticalSpace = original.grabExcessVerticalSpace;
         copy.minimumWidth = original.minimumWidth;
         copy.minimumHeight = original.minimumHeight;
         copy.exclude = original.exclude;
         return copy;
      }

      private static <T extends Control> T findDirectChild(Composite parent, Class<T> type)
      {
         if ((parent == null) || parent.isDisposed())
            return null;

         for(Control child : parent.getChildren())
         {
            if (type.isInstance(child))
               return type.cast(child);
         }
         return null;
      }

      private static <T extends Control> T findDescendant(Composite parent, Class<T> type)
      {
         for(Control child : parent.getChildren())
         {
            if (type.isInstance(child))
               return type.cast(child);
            if (child instanceof Composite)
            {
               T result = findDescendant((Composite)child, type);
               if (result != null)
                  return result;
            }
         }
         return null;
      }

      private static <T extends Control> boolean containsDescendant(Composite parent, Class<T> type)
      {
         return findDescendant(parent, type) != null;
      }
   }

   private enum ShellMode
   {
      WIDE,
      COMPACT,
      NARROW
   }
}
