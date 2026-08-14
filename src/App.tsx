import { Center, Loader } from '@mantine/core'
import { Route, Routes } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { SignIn } from './pages/SignIn'
import { Layout } from './components/Layout'
import { PollList } from './pages/PollList'
import { CreatePoll } from './pages/CreatePoll'
import { PollDetail } from './pages/PollDetail'

function App() {
  const { session, loading } = useAuth()

  if (loading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    )
  }

  if (!session) {
    return <SignIn />
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<PollList />} />
        <Route path="polls/new" element={<CreatePoll />} />
        <Route path="polls/:pollId" element={<PollDetail />} />
      </Route>
    </Routes>
  )
}

export default App
