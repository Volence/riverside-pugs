import React from 'react';
import { Link } from 'react-router-dom';
import Header from '../common/Header';

export default function Landing() {
  return (<React.Fragment>
    <Header>
      {/* <Link to="/login">Log in</Link> */}
      <button onClick={async() => {
        const res = await fetch('/auth/steam')
          console.log('res', res)
          window.location.href = res.url;
        }}>Login</button>
      <Link to="/signup">Sign Up</Link>
    </Header>
    <main className="centered-column">
      Welcome! Login or sign up!
    </main>
  </React.Fragment>)
}