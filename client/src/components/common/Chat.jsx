import React from 'react';
import { useCookies } from 'react-cookie';
import { makeStyles } from '@material-ui/core/styles';
import List from '@material-ui/core/List';
import Paper from '@material-ui/core/Paper';
import ListItem from '@material-ui/core/ListItem';
import Divider from '@material-ui/core/Divider';
import ListItemText from '@material-ui/core/ListItemText';
import ListItemAvatar from '@material-ui/core/ListItemAvatar';
import Avatar from '@material-ui/core/Avatar';
import Typography from '@material-ui/core/Typography';

const useStyles = makeStyles((theme) => ({
  root: {
    width: '100%',
    maxWidth: '64rem',
    margin: '0 auto',
    backgroundColor: theme.palette.background.paper,
  },
  inline: {
    display: 'inline',
  },
}));

const Chat = () => {
    const classes = useStyles();
    const [cookies] = useCookies(['token', 'user', 'id']);

    return (
      <Paper className={classes.root}>
      <List>
        <ListItem alignItems="flex-start">
          <ListItemAvatar>
            <Avatar variant="square" alt={cookies?.user?.personaname} src={cookies?.user?.avatar} />
          </ListItemAvatar>
          <ListItemText
            primary={cookies?.user?.personaname}
            secondary={
              <React.Fragment>
                <Typography
                  component="span"
                  variant="body2"
                  className={classes.inline}
                  color="textPrimary"
                >
                  Main text goes here
                </Typography>
              </React.Fragment>
            }
          />
        </ListItem>
        <Divider variant="inset" component="li" />
      </List>
      </Paper>
    );
}

export default Chat;