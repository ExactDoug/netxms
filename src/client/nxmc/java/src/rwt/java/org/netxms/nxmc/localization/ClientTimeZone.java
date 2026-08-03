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
package org.netxms.nxmc.localization;

import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.time.DateTimeException;
import java.time.ZoneId;
import java.util.SimpleTimeZone;
import java.util.TimeZone;
import org.eclipse.rap.rwt.RWT;
import org.eclipse.rap.rwt.client.service.ClientInfo;
import jakarta.servlet.http.Cookie;

/**
 * Browser timezone resolver for RWT client.
 */
public final class ClientTimeZone
{
   private static final String COOKIE_NAME = "nxmcClientTimeZone";
   private static final String SESSION_ATTRIBUTE = "netxms.clientTimeZone";

   /**
    * Get browser timezone for current UI session.
    *
    * @return browser timezone or JVM default if browser timezone cannot be determined
    */
   public static TimeZone get()
   {
      TimeZone timeZone = (TimeZone)RWT.getUISession().getAttribute(SESSION_ATTRIBUTE);
      if (timeZone != null)
         return timeZone;

      timeZone = getTimeZoneFromCookie();
      if (timeZone == null)
         timeZone = getTimeZoneFromClientInfo();
      if (timeZone == null)
         timeZone = TimeZone.getDefault();

      RWT.getUISession().setAttribute(SESSION_ATTRIBUTE, timeZone);
      return timeZone;
   }

   /**
    * Get browser timezone from cookie populated by client-side JavaScript.
    *
    * @return browser timezone or null
    */
   private static TimeZone getTimeZoneFromCookie()
   {
      final Cookie[] cookies;
      try
      {
         cookies = RWT.getRequest().getCookies();
      }
      catch(IllegalStateException e)
      {
         return null;
      }

      if (cookies == null)
         return null;

      for(Cookie cookie : cookies)
      {
         if (COOKIE_NAME.equals(cookie.getName()))
         {
            try
            {
               String timeZoneId = URLDecoder.decode(cookie.getValue(), "UTF-8");
               if (timeZoneId.length() > 128)
                  return null;
               return TimeZone.getTimeZone(ZoneId.of(timeZoneId));
            }
            catch(UnsupportedEncodingException | IllegalArgumentException | DateTimeException e)
            {
               return null;
            }
         }
      }
      return null;
   }

   /**
    * Get browser timezone from RAP client information. RAP provides only current
    * UTC offset, so this is used as a fixed-offset fallback when IANA timezone ID
    * is not available.
    *
    * @return browser timezone or null
    */
   private static TimeZone getTimeZoneFromClientInfo()
   {
      ClientInfo clientInfo = RWT.getClient().getService(ClientInfo.class);
      if (clientInfo == null)
         return null;

      try
      {
         int browserOffset = clientInfo.getTimezoneOffset();
         if ((browserOffset < -1440) || (browserOffset > 1440))
            return null;

         int minutesEastOfUtc = -browserOffset;
         int absoluteMinutes = Math.abs(minutesEastOfUtc);
         String id = String.format("GMT%c%02d:%02d", (minutesEastOfUtc >= 0) ? '+' : '-', absoluteMinutes / 60, absoluteMinutes % 60);
         return new SimpleTimeZone(minutesEastOfUtc * 60000, id);
      }
      catch(IllegalStateException e)
      {
         return null;
      }
   }

   /**
    * Prevent instantiation.
    */
   private ClientTimeZone()
   {
   }
}
