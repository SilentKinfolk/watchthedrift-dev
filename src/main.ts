import './app.css'
import { Screen } from './ui/Screen'

const root = document.querySelector<HTMLElement>('#app')
if (root) new Screen(root)
