import { UserList } from './components/UserList'
import { formatName } from '@acme/shared'
export const App = () => UserList({ fmt: formatName })
