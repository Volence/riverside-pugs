import React from 'react';
import { useCookies } from 'react-cookie';
import Chat from '../common/Chat';

const Home = () => {
    const [cookies] = useCookies(['token', 'user', 'id']);

  return (
      <React.Fragment>
        {cookies?.user?.personaname ? <main className="centered-column">
        Welcome, {cookies.user.personaname}
        </main> :
        <main className="centered-column">
        Welcome, please sign in!
        </main>}
        <Chat />
    </React.Fragment>
  )
}

export default Home;