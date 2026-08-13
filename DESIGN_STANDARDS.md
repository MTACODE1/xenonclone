# More Than Accountants — Frontend Design Standards
> Use this document to build any new software to the same design standard as the MTA KPI Management app.

---

## 1. Tech Stack

| Layer | Library | Version |
|---|---|---|
| UI Framework | `@mui/material` | v5.16.7 |
| Icons | `@mui/icons-material` + `@tabler/icons` | v5 / v1.84 |
| Styling | `@emotion/react` + `@emotion/styled` | latest |
| State | Redux Toolkit + React-Redux | v1.8 / v8 |
| Forms | Formik + Yup | v2.2 / v0.32 |
| HTTP | axios | v1.7 |
| Auth | jwt-decode | v4 |
| Charts | ApexCharts + react-apexcharts | v4.7 |
| Routing | React Router v6 | v6 |
| Date | date-fns / moment | v2 |

---

## 2. Brand Colors

### Primary Brand Color
```
Dark Blue:  #01406A   ← used on all customer-facing pages, payment flows, forms
```

### MUI Theme Palette (default — BLUE_THEME)
```
Primary Main:        #5D87FF
Primary Light:       #ECF2FF
Primary Dark:        #4570EA

Secondary Main:      #49BEFF
Secondary Light:     #E8F7FF
Secondary Dark:      #23AFDB

Success:             #13DEB9
Error:               #FA896B
Warning:             #FFAE1F
Info:                #539BFF
```

### Dark Mode Colors
```
Background default:  #171c23
Background paper:    #2A3447
Text primary:        #EAEFF4
Text secondary:      #7C8FAC
Divider:             #333F55
```

### Status / Tag Colors (used in chips, badges)
```
Open/Active:         #22c55e
Pending:             #f59e0b
Closed/Inactive:     #6b7280
Error/Spam:          #ef4444
Info/Blue:           #3B82F6
```

---

## 3. Typography

**Font:** `Plus Jakarta Sans` (Google Font — always import this)

```css
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap');
```

| Tag | Size | Weight | Line Height |
|---|---|---|---|
| h1 | 2.25rem | 600 | 2.75rem |
| h2 | 1.875rem | 600 | 2.25rem |
| h3 | 1.5rem | 600 | 1.75rem |
| h4 | 1.3125rem | 600 | 1.6rem |
| h5 | 1.125rem | 600 | 1.6rem |
| h6 | 1rem | 600 | 1.2rem |
| body1 | 0.875rem | 400 | 1.334rem |
| body2 | 0.75rem | 400 | 1rem |

**Button text:** `textTransform: 'capitalize'`, weight 400

---

## 4. Spacing, Borders & Shadows

```
Border Radius:     7px  (global MUI border radius override)
Sidebar Width:     270px (full) / 87px (mini/collapsed)
Topbar Height:     70px
Content Padding:   24px (standard page padding)
Card Padding:      16–24px
```

**Standard border:** `1px solid #e2e8f0`

**Shadows (examples):**
```
Subtle:   0px 2px 3px rgba(0,0,0,0.10)
Card:     0 0 1px 0 rgba(0,0,0,0.31), 0 2px 2px -2px rgba(0,0,0,0.25)
Elevated: 0 6px 18px 0 rgba(0,0,0,0.06)
```

---

## 5. Layout Structure

```
App
├── FullLayout (authenticated)
│   ├── Sidebar (vertical, collapsible, 270px)
│   │   ├── Logo
│   │   ├── User Profile section
│   │   └── Menu items (grouped by section)
│   └── PageWrapper (flex: 1)
│       ├── Header / AppBar (sticky, 70px, blur backdrop)
│       │   ├── Menu toggle button (mobile)
│       │   └── Right: Profile dropdown
│       └── Main content area
│           └── <Outlet /> (page components)
└── BlankLayout (public — login, forms, payments)
```

**AppBar styling:**
```javascript
{
  position: 'sticky',
  bgcolor: 'background.paper',
  boxShadow: 'none',
  backdropFilter: 'blur(4px)',
  borderBottom: '1px solid',
  borderColor: 'divider',
}
```

---

## 6. Page Structure (Standard Page Template)

Every page should follow this structure:

```jsx
import PageContainer from '../components/container/PageContainer';
import Breadcrumb from '../layouts/full/shared/breadcrumb/Breadcrumb';

const BCrumb = [
  { to: '/', title: 'Home' },
  { title: 'Current Page' },
];

const MyPage = () => {
  return (
    <PageContainer title="Page Title" description="brief description">
      <Breadcrumb title="Page Title" subtitle="What this page does" items={BCrumb} />
      {/* page content here */}
    </PageContainer>
  );
};

export default MyPage;
```

**Breadcrumb header style:**
- Light primary background (`primary.light`)
- Decorative image top-right
- Title (h4), Subtitle (body2), breadcrumb trail

---

## 7. Sidebar Menu

### Menu item structure (MenuItems.js):
```javascript
import { IconInbox, IconDashboard } from '@tabler/icons';
import { uniqueId } from 'lodash';

const Menuitems = [
  {
    navlabel: true,
    subheader: 'Section Name',
  },
  {
    id: uniqueId(),
    title: 'Page Name',
    icon: IconDashboard,
    href: '/page-path',
    // optional:
    chip: 'New',
    chipColor: 'primary',
    // or nested:
    children: [
      { id: uniqueId(), title: 'Sub Item', icon: IconInbox, href: '/sub' }
    ]
  },
];
```

### Sidebar item active/hover states:
```javascript
// Active (selected):
{ bgcolor: 'primary.main', color: 'white' }

// Hover:
{ bgcolor: 'primary.light', color: 'primary.main' }
```

---

## 8. Routing (Router.js)

All pages use lazy loading via a `Loadable` HOC:

```javascript
import { lazy } from 'react';
import Loadable from '../layouts/full/shared/loadable/Loadable';

const MyPage = Loadable(lazy(() => import('../apppages/MyPage')));

// Route definition
{ path: '/my-page', exact: true, element: <AdminRoute><MyPage /></AdminRoute> }
```

**Route guards available:**
- `<AdminRoute>` — requires `is_admin: true`
- `<AdminOrTeamLeaderRoute>` — requires `is_admin` OR `team_leader`
- `<AuthGuard>` — requires valid JWT token

---

## 9. Authentication

**JWT stored in:** `localStorage['token']`

**Token attached via axios interceptor:**
```javascript
axios.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});
```

**Auth check on load:**
- Decode JWT with `jwt-decode`
- Check expiry
- Optionally validate IP via `/api/check-ip`
- Redirect to `/login` if invalid/expired

---

## 10. Axios Config

```javascript
// src/utils/axios.js
import axios from 'axios';

const isDev = import.meta.env.MODE === 'development';
const axiosInstance = axios.create({
  baseURL: isDev
    ? 'http://127.0.0.1:5001'
    : 'https://wf.morethanaccountants.co.uk:5000',
});

// Attach JWT token to every request
axiosInstance.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export default axiosInstance;
```

---

## 11. MUI Component Conventions

### Cards
```jsx
<Card sx={{ p: 3, borderRadius: 2, border: '1px solid #e2e8f0', boxShadow: 'none' }}>
  <CardContent>...</CardContent>
</Card>
```

### Chips / Status Badges
```jsx
// Status chip
<Chip
  label="open"
  size="small"
  sx={{
    height: 20,
    fontSize: 11,
    bgcolor: '#22c55e20',  // color + 20 for light background
    color: '#22c55e',
  }}
/>

// Brand chip (dark blue)
<Chip
  label="Count"
  size="small"
  sx={{ bgcolor: '#01406A', color: '#fff', height: 20, fontSize: 11 }}
/>
```

### Avatars
```jsx
<Avatar sx={{ width: 36, height: 36, bgcolor: '#01406A', fontSize: 13 }}>
  AK
</Avatar>
```

### Buttons — Primary
```jsx
<Button
  variant="contained"
  sx={{
    bgcolor: '#01406A',
    textTransform: 'none',
    '&:hover': { bgcolor: '#012d4a' },
  }}
>
  Action
</Button>
```

### Buttons — Outlined
```jsx
<Button variant="outlined" sx={{ textTransform: 'none', borderColor: '#01406A', color: '#01406A' }}>
  Secondary Action
</Button>
```

### TextFields
```jsx
<TextField
  size="small"
  fullWidth
  variant="outlined"
  placeholder="Enter value…"
  sx={{ '& .MuiOutlinedInput-root': { fontSize: 14, borderRadius: 2 } }}
/>
```

### Dialogs / Modals
```jsx
<Dialog open={open} onClose={onClose} fullWidth maxWidth="sm"
  PaperProps={{ sx: { borderRadius: 2 } }}>
  <DialogTitle sx={{ fontWeight: 700, color: '#01406A', display: 'flex', justifyContent: 'space-between' }}>
    Dialog Title
    <IconButton size="small" onClick={onClose}><Close /></IconButton>
  </DialogTitle>
  <DialogContent sx={{ pt: '8px !important' }}>
    {/* content */}
  </DialogContent>
  <DialogActions sx={{ px: 3, pb: 2 }}>
    <Button onClick={onClose} sx={{ textTransform: 'none', color: '#64748b' }}>Cancel</Button>
    <Button variant="contained" sx={{ bgcolor: '#01406A', textTransform: 'none' }}>Confirm</Button>
  </DialogActions>
</Dialog>
```

### Snackbar / Toasts
```jsx
const [snack, setSnack] = useState({ open: false, msg: '', severity: 'success' });

<Snackbar
  open={snack.open}
  autoHideDuration={3000}
  onClose={() => setSnack(s => ({ ...s, open: false }))}
  anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
>
  <Alert severity={snack.severity} onClose={() => setSnack(s => ({ ...s, open: false }))}>
    {snack.msg}
  </Alert>
</Snackbar>
```

### Tabs
```jsx
<Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2, minHeight: 36 }}>
  <Tab label="Tab One" sx={{ minHeight: 36, textTransform: 'none', fontSize: 13 }} />
  <Tab label="Tab Two" sx={{ minHeight: 36, textTransform: 'none', fontSize: 13 }} />
</Tabs>
```

### Toggle Button Groups (filters)
```jsx
<ToggleButtonGroup value={filter} exclusive size="small" fullWidth
  onChange={(_, v) => { if (v) setFilter(v); }}>
  {['option1', 'option2', 'option3'].map(o => (
    <ToggleButton key={o} value={o} sx={{ fontSize: 11, textTransform: 'capitalize', py: 0.4 }}>
      {o}
    </ToggleButton>
  ))}
</ToggleButtonGroup>
```

---

## 12. Full-Page (Dark Blue) Layouts

Used for customer-facing pages — payment forms, document signing, public forms:

```jsx
<Box sx={{
  minHeight: '100vh',
  bgcolor: '#01406A',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}}>
  <Paper sx={{ p: 4, borderRadius: 3, maxWidth: 480, width: '100%' }}>
    {/* white card content */}
  </Paper>
</Box>
```

---

## 13. File & Folder Structure

```
src/
├── apppages/          ← Business logic pages (one file per page)
│   └── forms/         ← Form-specific pages
├── components/        ← Reusable shared components
│   └── container/     ← PageContainer
├── layouts/
│   └── full/
│       ├── vertical/
│       │   ├── header/    ← AppBar, Profile, Search
│       │   └── sidebar/   ← Sidebar, MenuItems, NavItem, NavCollapse
│       └── shared/
│           ├── breadcrumb/
│           ├── customizer/
│           ├── loadable/
│           └── logo/
├── routes/
│   ├── Router.js      ← All route definitions
│   └── AuthGuard.js   ← Auth + IP check
├── store/             ← Redux store + slices
├── theme/             ← MUI theme config (colors, typography, shadows)
└── utils/
    └── axios.js       ← Axios instance with JWT interceptor
```

**Naming conventions:**
- Pages: `PascalCase.js` (e.g. `LeadManagement.js`)
- Tab components: `XxxTab.js` (e.g. `AccountTab.js`)
- Dialogs: `XxxDialog.js`
- Icons: use `@tabler/icons` — `IconInbox`, `IconDashboard`, etc.

---

## 14. Redux / State Management

**Store slices:**
- `CustomizerSlice` — theme mode, active theme, layout, border radius, sidebar width

**Usage:**
```javascript
import { useSelector, useDispatch } from 'react-redux';
import { setTheme } from '../store/customizer/CustomizerSlice';

const { activeMode, activeTheme } = useSelector(state => state.customizer);
```

**Local component state** uses standard `useState` + `useCallback` hooks.

---

## 15. Responsive Breakpoints

| Breakpoint | Width |
|---|---|
| xs | 0px (mobile) |
| sm | 600px (tablet) |
| md | 900px (small desktop) |
| lg | 1200px (desktop) |
| xl | 1536px (large desktop) |

**Sidebar behaviour:**
- `lg` and above → permanent drawer (always visible)
- Below `lg` → temporary drawer (opens/closes with toggle)

---

## 16. Floating Action Buttons (FABs)

```jsx
// Fixed bottom-right FABs (e.g. AI assistant, theme customizer)
<Fab
  sx={{
    position: 'fixed',
    bottom: 84,
    right: 25,
    bgcolor: '#01406A',
    '&:hover': { bgcolor: '#012d4a' },
  }}
  onClick={handleClick}
>
  <IconRobot />
</Fab>
```

---

## Quick Checklist for New Software

When starting a new app to match this design:

- [ ] Install MUI v5, Emotion, Tabler Icons
- [ ] Import `Plus Jakarta Sans` font
- [ ] Set up MUI theme with `#5D87FF` primary, `Plus Jakarta Sans` font, `7px` border radius
- [ ] Brand secondary color: `#01406A` (dark blue) for headers, highlighted buttons
- [ ] Use `FullLayout` with collapsible sidebar (270px) and sticky 70px AppBar
- [ ] All pages wrapped in `PageContainer` + `Breadcrumb`
- [ ] All routes lazy-loaded with `Loadable`
- [ ] JWT in `localStorage['token']`, attached via axios interceptor
- [ ] `textTransform: 'none'` and `textTransform: 'capitalize'` on all buttons (never uppercase)
- [ ] Snackbar anchored to `bottom-right` for toast notifications
- [ ] Status chips use `color + '20'` for semi-transparent backgrounds
- [ ] `borderRadius: 2` (16px) on dialogs, `borderRadius: 1` (8px) on cards/inputs
