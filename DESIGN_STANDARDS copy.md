# MTA KPI App — Design Standards

A complete reference for replicating the look, feel, and structure of this app in any new project.

---

## 1. Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React (Vite) |
| UI Library | MUI v5 (Material UI) |
| Styling | MUI `sx` prop + `styled()` API |
| Icons | `@tabler/icons` (e.g. `IconInbox`, `IconUsers`) |
| State | Redux Toolkit (`useSelector`, `useDispatch`) |
| Routing | React Router v6 (`Outlet`, `Navigate`) |
| HTTP | Axios (custom instance with JWT interceptor) |
| Fonts | Plus Jakarta Sans (Google Fonts) |

---

## 2. Typography

Font family: **Plus Jakarta Sans**

```js
const typography = {
  fontFamily: "'Plus Jakarta Sans', sans-serif",
  h1: { fontWeight: 600, fontSize: '2.25rem',   lineHeight: '2.75rem' },
  h2: { fontWeight: 600, fontSize: '1.875rem',  lineHeight: '2.25rem' },
  h3: { fontWeight: 600, fontSize: '1.5rem',    lineHeight: '1.75rem' },
  h4: { fontWeight: 600, fontSize: '1.3125rem', lineHeight: '1.6rem'  },
  h5: { fontWeight: 600, fontSize: '1.125rem',  lineHeight: '1.6rem'  },
  h6: { fontWeight: 600, fontSize: '1rem',      lineHeight: '1.2rem'  },
  body1: { fontSize: '0.875rem', fontWeight: 400, lineHeight: '1.334rem' },
  body2: { fontSize: '0.75rem',  fontWeight: 400, lineHeight: '1rem'     },
  button: { textTransform: 'capitalize', fontWeight: 400 },
};
```

> **Rule:** Button labels are capitalised (not ALL CAPS). MUI's default `uppercase` is overridden.

---

## 3. Colour Palette

### Brand / App colours (hardcoded, not theme)

| Name | Hex | Where used |
|---|---|---|
| MTA Dark Blue | `#01406A` | Legacy accents (some app shells); prefer Workflow Blue for Inbox |
| Workflow Blue (Inbox) | `#2563eb` | Inbox mail UI, workflows settings, nav accent, primary actions in that area |
| Text Primary | `#2A3547` | Body text, labels |
| Divider | `#e5eaef` | Card borders, table lines |
| Page background | `#ffffff` | Default light mode background |

### MUI Semantic Colours (light mode base)

```
primary.main    #5D87FF    (default theme = BLUE_THEME)
primary.light   #ECF2FF
primary.dark    #4570EA

secondary.main  #49BEFF
secondary.light #E8F7FF

success.main    #13DEB9
success.light   #E6FFFA

error.main      #FA896B
error.light     #FDEDE8

warning.main    #FFAE1F
warning.light   #FEF5E5

info.main       #539BFF
info.light      #EBF3FE

grey.100  #F2F6FA   (page backgrounds, subtle fills)
grey.200  #EAEFF4
grey.300  #DFE5EF   (borders)
grey.400  #7C8FAC   (muted text)
grey.500  #5A6A85
grey.600  #2A3547   (strong text)
```

### Available theme presets (user-switchable)

The app ships with 6 colour themes. Each changes `primary` and `secondary`:

| Theme name | Primary | Secondary |
|---|---|---|
| BLUE_THEME *(default)* | `#5D87FF` | `#49BEFF` |
| AQUA_THEME | `#0074BA` | `#47D7BC` |
| PURPLE_THEME | `#763EBD` | `#95CFD5` |
| GREEN_THEME | `#0A7EA4` | `#CCDA4E` |
| CYAN_THEME | `#01C0C8` | `#FB9678` |
| ORANGE_THEME | `#FA896B` | `#0074BA` |

---

## 4. Shape & Spacing

| Property | Value |
|---|---|
| Border radius (global) | `7px` |
| Sidebar width (expanded) | `270px` |
| Sidebar width (collapsed) | `87px` |
| Topbar height | `70px` |
| Default layout mode | Boxed (`maxWidth: 'lg'`) |
| Page bottom padding | `60px` |

Set via Redux `customizer` state:
```js
{
  SidebarWidth: 270,
  MiniSidebarWidth: 87,
  TopbarHeight: 70,
  borderRadius: 7,
  isLayout: 'boxed',
}
```

---

## 5. Layout Structure

```
<MainWrapper>  ← display:flex, min-height:100vh
  <Sidebar />  ← permanent Drawer, 270px wide (desktop)
  <PageWrapper>  ← flexGrow:1, flexDirection:column
    <Header />   ← top bar, 70px tall
    <Container>  ← maxWidth:'lg' (boxed) or 100% (full)
      <Box sx={{ minHeight: 'calc(100vh - 170px)' }}>
        <Outlet />  ← page content renders here
      </Box>
    </Container>
  </PageWrapper>
</MainWrapper>
```

### Sidebar
- Permanent `Drawer` on desktop (`lg` breakpoint and up)
- Temporary `Drawer` (overlay) on mobile
- Background: `#01406A` (dark blue) by default — set via `activeSidebarBg`
- Text colour: white when sidebar has a coloured background
- Logo sits at top inside `Box px={3}`, height = `TopbarHeight` (70px)
- Menu items scroll inside `<Scrollbar>` (flex:1, minHeight:0)
- Collapse/expand button at the very bottom, borderTop

### Header (Topbar)
- Height: `70px`
- Contains: search, notifications, profile menu, quick links
- On mobile: hamburger menu that opens the sidebar Drawer

---

## 6. Axios Setup

All API calls go through a shared Axios instance at `src/utils/axios.js`:

```js
const baseURL = process.env.NODE_ENV === 'development'
  ? 'http://127.0.0.1:5001'
  : 'https://wf.morethanaccountants.co.uk:5000';

const axiosServices = axios.create({ baseURL });

axiosServices.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers['Authorization'] = `Bearer ${token}`;
  return config;
});

export default axiosServices;
```

> **Always import from `src/utils/axios`**, not from the raw `axios` package, so JWT is automatically attached.

---

## 7. Routing & Lazy Loading

All pages are lazy-loaded with a custom `Loadable` HOC that shows a spinner while the chunk loads:

```js
import Loadable from '../layouts/full/shared/loadable/Loadable';

const MyPage = Loadable(lazy(() => import('../apppages/MyPage')));
```

Route structure:
```js
{
  path: '/',
  element: <AuthGuard><FullLayout /></AuthGuard>,  // protected
  children: [
    { path: 'my-page', element: <MyPage /> },
    ...
  ]
}
```

Public routes (login, forms, payment) use `<BlankLayout />` with no sidebar.

---

## 8. Sidebar Menu Items

Menu items are defined dynamically in `MenuItems.js`. Each item follows this shape:

```js
{
  id: uniqueId(),
  title: 'Inbox',
  icon: IconInbox,
  href: '/inbox',
  chip: '5',           // optional badge (string)
  chipColor: 'error',  // optional chip colour
}
```

Grouped into sections:
```js
{
  id: uniqueId(),
  subheader: 'Section Title',
  children: [ ...items ]
}
```

Conditional visibility is handled by role flags fetched from `/api/get-user-data`:
- `is_admin` — full access
- `team_leader` — extra management items
- `team === 'Onboarding Team'` — onboarding-specific items
- `team === 'Launch Pad Team'` — launchpad items

---

## 9. MUI Component Overrides

Global component overrides are in `src/theme/Components.js`. Key ones:

```js
// Buttons: no text transform, no shadow
MuiButton: { styleOverrides: { root: { boxShadow: 'none' } } }

// Paper: no extra border, no gradient image
MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } }

// All box-sizing: border-box
'*': { boxSizing: 'border-box' }

// Border radius follows theme.shape.borderRadius (7px)
'.MuiBox-root': { borderRadius: theme.shape.borderRadius }

// Links: no underline
a: { textDecoration: 'none' }

// Hover card scale effect
'.hoverCard:hover': { scale: '1.01', transition: '0.1s ease-in' }

// Utility class for small icon buttons
'.btn-xs': { minWidth: '30px', width: '30px', height: '30px', borderRadius: '6px', padding: '0px' }
```

---

## 10. Common Page Patterns

### Standard page container
```jsx
<Box sx={{ p: 3 }}>
  <Typography variant="h4" mb={2}>Page Title</Typography>
  {/* content */}
</Box>
```

### Card
```jsx
<Box sx={{
  backgroundColor: 'background.paper',
  borderRadius: '7px',
  border: '1px solid',
  borderColor: 'divider',
  p: 2,
}}>
```

### Status chips
```jsx
<Chip
  label="Open"
  color="success"   // or "error", "warning", "info", "default"
  size="small"
  sx={{ borderRadius: '7px', fontWeight: 600 }}
/>
```

### Primary action button
```jsx
<Button
  variant="contained"
  color="primary"
  size="small"
  sx={{ borderRadius: '7px', textTransform: 'capitalize' }}
>
  Save
</Button>
```

### Outlined secondary button
```jsx
<Button
  variant="outlined"
  color="secondary"
  size="small"
  sx={{ borderRadius: '7px' }}
>
  Cancel
</Button>
```

### Data table
```jsx
<TableContainer component={Box} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: '7px' }}>
  <Table size="small">
    <TableHead sx={{ backgroundColor: 'grey.100' }}>
      <TableRow>
        <TableCell sx={{ fontWeight: 600, color: 'text.primary' }}>Column</TableCell>
      </TableRow>
    </TableHead>
    <TableBody>
      <TableRow hover>
        <TableCell>value</TableCell>
      </TableRow>
    </TableBody>
  </Table>
</TableContainer>
```

---

## 11. Floating Action Button (FAB) Pattern

The app uses FABs for secondary global actions (AI assistant, settings):

```jsx
<Fab
  size="medium"
  onClick={handleOpen}
  sx={{
    position: 'fixed',
    bottom: 84,          // stacked above the settings FAB at bottom:24
    right: 24,
    backgroundColor: '#01406A',
    color: 'white',
    '&:hover': { backgroundColor: '#012d4a' },
    zIndex: 1200,
  }}
>
  <IconRobot size={20} />
</Fab>
```

---

## 12. Auth & Role Guards

`AuthGuard` wraps all protected routes. It reads the JWT from `localStorage.getItem('token')` and redirects to `/login` if missing or expired.

Role checks are done by calling `/api/get-user-data` after login and storing the response in component state (not Redux). Key flags returned:
- `is_admin: boolean`
- `team_leader: boolean`
- `team: string` (e.g. `'Onboarding Team'`, `'Launch Pad Team'`)
- `username: string`
- `email: string`

---

## 13. File & Folder Structure

```
frontend/src/
├── apppages/          # All app pages (one file per page)
├── apppages-uae/      # UAE-specific variants of pages
├── assets/
│   └── images/logos/  # Logo files
├── components/        # Shared reusable components
│   └── forms/
│       └── theme-elements/  # MUI form field wrappers
├── context/           # React Context providers
├── layouts/
│   ├── full/          # Main authenticated layout
│   │   ├── FullLayout.js
│   │   ├── vertical/
│   │   │   ├── header/    # Topbar components
│   │   │   └── sidebar/   # Sidebar, MenuItems, NavItem, NavGroup
│   │   └── shared/
│   │       ├── loadable/  # Loadable HOC
│   │       ├── logo/      # Logo component
│   │       └── customizer/ # Theme switcher panel
│   ├── blank/         # Public layout (no sidebar)
│   └── inbox/         # Standalone inbox layout
├── routes/
│   ├── Router.js      # All route definitions
│   └── AuthGuard.js   # JWT route protection
├── store/
│   └── customizer/
│       └── CustomizerSlice.js  # Theme/layout Redux state
├── theme/
│   ├── Theme.js            # BuildTheme function
│   ├── Typography.js       # Font scale
│   ├── DefaultColors.js    # Base light/dark palette
│   ├── LightThemeColors.js # 6 theme presets
│   ├── DarkThemeColors.js
│   ├── Components.js       # Global MUI overrides
│   └── Shadows.js
└── utils/
    └── axios.js        # Axios instance with JWT interceptor
```

---

## 14. Dark Mode

Dark mode swaps the base palette but keeps the same structure. Key differences:

```
background.default  #171c23
background.paper    #171c23
text.primary        #EAEFF4
text.secondary      #7C8FAC
grey.100            #333F55  (used for hover/card backgrounds)
divider             #333F55
```

Toggled via Redux: `dispatch(setDarkMode('dark'))` or `dispatch(setDarkMode('light'))`.

---

## 15. Quick Checklist for a New Project

- [ ] Install MUI v5, `@tabler/icons`, `@reduxjs/toolkit`, `react-redux`, `react-router-dom`, `axios`
- [ ] Add `Plus Jakarta Sans` to `index.html` via Google Fonts link
- [ ] Copy `theme/` folder (Typography, DefaultColors, LightThemeColors, Components, Theme)
- [ ] Set up `CustomizerSlice` in Redux store
- [ ] Create `utils/axios.js` with base URL and JWT interceptor
- [ ] Build `FullLayout` (MainWrapper + Sidebar + PageWrapper + Header)
- [ ] Set sidebar background to `#01406A`
- [ ] Set global `borderRadius: 7` via `customizer.borderRadius`
- [ ] Wrap protected routes with `AuthGuard`
- [ ] Use `Loadable(lazy(() => import(...)))` for all page components
