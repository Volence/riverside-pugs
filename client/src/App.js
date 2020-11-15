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


import Home from './components/pages/Home';
import Login from './components/pages/Login';
import Signup from './components/pages/Signup';
import Header from './components/common/Header';

import loadingSpinner from './assets/loading.gif';
import auth from './services/auth';

function AuthenticatedApp() {

  return (
    <Router>

      <Switch>
        <Route exact path="/" component={Home} />
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
        <Route exact path="/" component={Home} />
        <Route path="*">
          {/* <Redirect to="/" /> */}
        </Route>
      </Switch>
    </Router>
  )
}

function App() {
  const [cookies, setCookie, removeCookie] = useCookies(['token', 'user', 'id']);
  useEffect(() => {
    (async() => {
      const queryString = window.location.search;
      if(queryString && !cookies.token) {
        const jsonData = await fetch(`/auth/steam/return${queryString}`);
        const {token, user, id} = await jsonData.json();
        console.log('userData', token, id, user);
        setCookie('token', token, { path: '/' });
        setCookie('user', user, { path: '/' });
        setCookie('id', id, { path: '/' });
      }
      if (window.location.pathname === "/auth/steam/return") {
        // window.location.search = "";
        window.location.pathname = "/";
      }
    })();
  }, [])

  return (<React.Fragment>
      <Header />
    {/* {userPending && <img
      className="page-loading-spinner"
      width={24}
      alt="loading"
      src={loadingSpinner} />} */}
    {cookies.token && <AuthenticatedApp />}
    {!cookies.token && <UnauthenticatedApp />}
    <ToastContainer />
  </React.Fragment>);
}

export default App;
