import React, {useEffect} from 'react';
import { useCookies } from 'react-cookie';

import {
  BrowserRouter as Router,
  Switch,
  Route,
  Redirect
} from "react-router-dom";
import 'react-toastify/dist/ReactToastify.css';
import { ToastContainer } from 'react-toastify';

import { useUserContext } from './contexts/User';

import Dashboard from './components/pages/Dashboard';
import Login from './components/pages/Login';
import Signup from './components/pages/Signup';
import Landing from './components/pages/Landing';
import Header from './components/common/Header';

import loadingSpinner from './assets/loading.gif';
import auth from './services/auth';

function AuthenticatedApp() {
  const userContext = useUserContext();

  return (
    <Router>
      <Header>
        {/* <span>{`Logged in as: ${userContext.user.username}`}
        </span> */}
        <button onClick={() => {
          auth.logout();
          userContext.setUser(null);
        }}>Logout</button>
      </Header>
      <Switch>
        <Route path="/dashboard" component={Dashboard} />
        <Route path="*">
          {/* <Redirect to="/dashboard" /> */}
        </Route>
      </Switch>
    </Router>
  )
}

function UnauthenticatedApp() {
  return (
    <Router>
      <Switch>
        <Route path="/signup" component={Signup} />
        <Route path="/login" component={Login} />
        <Route exact path="/" component={Landing} />
        <Route path="*">
          {/* <Redirect to="/" /> */}
        </Route>
      </Switch>
    </Router>
  )
}

function App() {
  const userContext = useUserContext();
  const [cookies, setCookie, removeCookie] = useCookies(['login']);
  const user = userContext.user;
  const userPending = userContext.userPending;
  useEffect(() => {
    (async() => {
      console.log('cookies', cookies.login)
      const queryString = window.location.search;
      if(queryString && !cookies.login) {
        const test = await fetch(`/auth/steam/return${queryString}`);
        const wait = await test.json();
        setCookie('login', wait, { path: '/' });
        console.log('test', wait);
      }
    })();
  }, [])

  return (<React.Fragment>
    {userPending && <img
      className="page-loading-spinner"
      width={24}
      alt="loading"
      src={loadingSpinner} />}
    {!userPending && !user && <AuthenticatedApp />}
    {!userPending && !user && <UnauthenticatedApp />}
    <ToastContainer />
  </React.Fragment>);
}

export default App;
